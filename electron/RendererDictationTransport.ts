import { ipcRenderer } from "electron";
import type {
  CaptureTargetMode,
  DictationPrepareRequest,
  DictationPrepareResult,
  DictationTransportFailureCode,
  StartListeningRequest,
  VoiceSnapshot,
} from "../shared/contracts.js";

const SESSION_ROLLOVER_MS = 270_000;
const ROLLOVER_RETRY_MS = 15_000;
const SESSION_START_TIMEOUT_MS = 10_000;
const SESSION_CLOSE_TIMEOUT_MS = 2_000;
const STARTUP_AUDIO_BUFFER_MS = 30_000;

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Dictation was stopped.", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

class RendererTransportError extends Error {
  constructor(
    message: string,
    readonly code: DictationTransportFailureCode,
  ) {
    super(message);
  }
}

interface TransportSession {
  socket: WebSocket;
  started: boolean;
  forwarded: boolean;
  expectedClose: boolean;
  startedEvent: Record<string, unknown> | null;
  failureCode: DictationTransportFailureCode;
  closeResolver: (() => void) | null;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function parseServerEvent(data: unknown): Record<string, unknown> {
  if (typeof data !== "string") {
    throw new RendererTransportError(
      "Dictation returned a non-text event.",
      "protocol-error",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new RendererTransportError(
      "Dictation returned invalid JSON.",
      "protocol-error",
    );
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    throw new RendererTransportError(
      "Dictation returned an invalid event.",
      "protocol-error",
    );
  }
  return value as Record<string, unknown>;
}

export class RendererDictationTransport {
  private activeSession: TransportSession | null = null;
  private standbySession: TransportSession | null = null;
  private sampleRate = 48_000;
  private targetMode: CaptureTargetMode = "configured";
  private targetBundleId: string | undefined;
  private targetContextId: string | undefined;
  private activeUtterance = false;
  private stopping = false;
  private starting = false;
  private reconnecting = false;
  private rolloverInFlight = false;
  private recoveryInFlight = false;
  private rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFrames: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private operation: Promise<void> = Promise.resolve();
  private connectionController = new AbortController();

  start(request: StartListeningRequest): Promise<VoiceSnapshot> {
    this.starting = true;
    this.stopping = false;
    this.sampleRate = request.sampleRate;
    const signal = this.connectionController.signal;
    return this.enqueue(async () => {
      signal.throwIfAborted();
      if (
        this.activeSession?.started &&
        this.activeSession.socket.readyState === WebSocket.OPEN
      ) {
        return ipcRenderer.invoke("voice:get-snapshot") as Promise<VoiceSnapshot>;
      }
      this.targetMode = request.targetMode ?? "configured";
      this.targetBundleId = request.targetBundleId;
      this.targetContextId = request.targetContextId;
      this.reconnecting = false;
      this.activeUtterance = false;
      this.clearRollover();
      try {
        const session = await this.connectWithRefreshRetry(false, undefined, signal);
        if (signal.aborted) {
          await this.closeSession(session, false);
          signal.throwIfAborted();
        }
        return await this.activateSession(session);
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = error instanceof RendererTransportError
          ? error
          : new RendererTransportError("Dictation connection failed.", "connection-failed");
        await this.reportFailure(failure.code);
        this.clearPendingFrames();
        throw new Error(failure.message);
      }
    }).finally(() => {
      this.starting = false;
    });
  }

  stop(): Promise<VoiceSnapshot> {
    const finishCapturedSpeech = this.starting && this.pendingBytes > 0;
    this.stopping = true;
    if (!finishCapturedSpeech) this.connectionController.abort();
    this.starting = false;
    this.reconnecting = false;
    this.clearRollover();
    return this.enqueue(async () => {
      const standby = this.standbySession;
      this.standbySession = null;
      if (standby) await this.closeSession(standby, false);

      const active = this.activeSession;
      if (active) await this.closeSession(active, true);
      this.activeSession = null;
      this.activeUtterance = false;
      this.clearPendingFrames();
      this.targetMode = "configured";
      this.targetBundleId = undefined;
      this.targetContextId = undefined;
      const snapshot = await ipcRenderer.invoke("voice:finish-dictation") as VoiceSnapshot;
      this.stopping = false;
      this.connectionController = new AbortController();
      return snapshot;
    });
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (this.stopping || buffer.byteLength === 0) return;
    const session = this.activeSession;
    if (session?.started && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: "audio.append", audio: toBase64(buffer) }));
      return;
    }
    if (this.starting || this.reconnecting || session || this.standbySession) {
      this.queueFrame(buffer);
    }
  }

  dispose(): void {
    this.stopping = true;
    this.connectionController.abort();
    this.starting = false;
    this.reconnecting = false;
    this.clearRollover();
    const sessions = [this.activeSession, this.standbySession];
    this.activeSession = null;
    this.standbySession = null;
    for (const session of sessions) {
      if (!session) continue;
      session.expectedClose = true;
      try {
        session.socket.close();
      } catch {
        // The renderer is shutting down.
      }
      session.closeResolver?.();
      session.closeResolver = null;
    }
    this.clearPendingFrames();
  }

  private async connectWithRefreshRetry(
    rollover: boolean,
    reconnectMode?: DictationPrepareRequest["reconnectMode"],
    signal = this.connectionController.signal,
  ): Promise<TransportSession> {
    try {
      return await this.openSession(false, rollover, reconnectMode, signal);
    } catch (error) {
      signal.throwIfAborted();
      return this.openSession(true, rollover, reconnectMode, signal).catch((retryError) => {
        throw retryError instanceof RendererTransportError ? retryError : error;
      });
    }
  }

  private async openSession(
    forceRefresh: boolean,
    rollover: boolean,
    reconnectMode: DictationPrepareRequest["reconnectMode"],
    signal: AbortSignal,
  ): Promise<TransportSession> {
    signal.throwIfAborted();
    const request: DictationPrepareRequest = {
      sampleRate: this.sampleRate,
      targetMode: this.targetMode,
      targetBundleId: this.targetBundleId,
      targetContextId: this.targetContextId,
      forceRefresh,
      rollover,
      reconnectMode,
    };
    const prepared = await abortable(ipcRenderer.invoke(
      "voice:prepare-dictation",
      request,
    ) as Promise<DictationPrepareResult>, signal);
    signal.throwIfAborted();
    const protocols = [...prepared.connection.protocols];
    const socket = new WebSocket(prepared.connection.websocketUrl, protocols);
    protocols.fill("");
    prepared.connection.protocols[1] = "";

    const session: TransportSession = {
      socket,
      started: false,
      forwarded: false,
      expectedClose: false,
      startedEvent: null,
      failureCode: "connection-closed",
      closeResolver: null,
    };

    await new Promise<void>((resolve, reject) => {
      let startupSettled = false;
      const settleResolve = () => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => {
        session.expectedClose = true;
        settleReject(new DOMException("Dictation was stopped.", "AbortError"));
        socket.close();
      };
      const timer = setTimeout(() => {
        session.expectedClose = true;
        socket.close();
        settleReject(new RendererTransportError(
          "Dictation session did not start in time.",
          "session-timeout",
        ));
      }, SESSION_START_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(prepared.connection.sessionStart));
      }, { once: true });

      socket.addEventListener("message", (message) => {
        let event: Record<string, unknown>;
        try {
          event = parseServerEvent(message.data);
        } catch (error) {
          const failure = error instanceof RendererTransportError
            ? error
            : new RendererTransportError("Dictation protocol failed.", "protocol-error");
          session.failureCode = failure.code;
          if (!session.started) settleReject(failure);
          socket.close();
          return;
        }

        if (event.type === "session.started") {
          session.started = true;
          session.startedEvent = event;
          settleResolve();
          return;
        }
        if (event.type === "session.error" && event.fatal === true) {
          session.failureCode = "connection-failed";
          if (!session.started) {
            settleReject(new RendererTransportError(
              "The dictation session reported an error.",
              "connection-failed",
            ));
          }
          socket.close();
          return;
        }
        if (
          event.type === "session.updated" &&
          event.session &&
          typeof event.session === "object" &&
          (event.session as { status?: unknown }).status === "closed"
        ) {
          socket.close();
          return;
        }
        if (this.activeSession === session && session.forwarded) {
          this.forwardServerEvent(event);
        }
      });

      socket.addEventListener("error", () => {
        session.failureCode = "connection-failed";
        if (!session.started) {
          settleReject(new RendererTransportError(
            "Dictation endpoint rejected the connection.",
            "connection-failed",
          ));
        }
        socket.close();
      }, { once: true });

      socket.addEventListener("close", () => {
        const wasActive = this.activeSession === session;
        const wasStandby = this.standbySession === session;
        if (wasActive) this.activeSession = null;
        if (wasStandby) this.standbySession = null;
        session.closeResolver?.();
        session.closeResolver = null;
        if (!startupSettled) {
          settleReject(new RendererTransportError(
            "Dictation connection closed before the session started.",
            session.failureCode,
          ));
          return;
        }
        if (session.expectedClose || this.stopping) return;
        if (wasActive) {
          const standby = this.standbySession;
          if (standby?.started && standby.socket.readyState === WebSocket.OPEN) {
            void this.activateSession(standby);
          } else {
            void this.recoverUnexpectedSession(session.failureCode);
          }
        } else if (wasStandby && this.activeSession) {
          this.scheduleRollover(ROLLOVER_RETRY_MS);
        }
      }, { once: true });
    });

    return session;
  }

  private async activateSession(session: TransportSession): Promise<VoiceSnapshot> {
    if (!session.started || session.socket.readyState !== WebSocket.OPEN) {
      throw new RendererTransportError(
        "The replacement dictation session is unavailable.",
        "connection-closed",
      );
    }
    const previous = this.activeSession;
    if (this.standbySession === session) this.standbySession = null;
    this.activeSession = session;
    session.forwarded = true;
    this.activeUtterance = false;
    if (session.startedEvent) {
      ipcRenderer.send("voice:dictation-event", session.startedEvent);
    }
    this.flushPendingFrames();
    if (!this.stopping) this.scheduleRollover();
    if (previous && previous !== session) {
      void this.closeSession(previous, true);
    }
    return ipcRenderer.invoke("voice:dictation-started") as Promise<VoiceSnapshot>;
  }

  private forwardServerEvent(event: Record<string, unknown>): void {
    ipcRenderer.send("voice:dictation-event", event);
    if (event.type === "speech.started" || event.type === "transcript.segment") {
      this.activeUtterance = true;
      return;
    }
    if (event.type === "transcript.final" || event.type === "transcript.failed") {
      this.activeUtterance = false;
      const standby = this.standbySession;
      if (standby) void this.activateSession(standby);
    }
  }

  private async performRollover(): Promise<void> {
    if (
      this.stopping ||
      this.rolloverInFlight ||
      !this.activeSession?.started ||
      this.standbySession
    ) {
      return;
    }
    this.rolloverInFlight = true;
    this.clearRollover();
    try {
      const replacement = await this.connectWithRefreshRetry(true, "planned");
      if (this.stopping) {
        await this.closeSession(replacement, false);
        return;
      }
      if (!this.activeSession) {
        await this.activateSession(replacement);
        return;
      }
      this.standbySession = replacement;
      if (!this.activeUtterance) await this.activateSession(replacement);
    } catch {
      if (this.activeSession && !this.stopping) {
        this.scheduleRollover(ROLLOVER_RETRY_MS);
      }
    } finally {
      this.rolloverInFlight = false;
    }
  }

  private async recoverUnexpectedSession(
    code: DictationTransportFailureCode,
  ): Promise<void> {
    if (this.stopping || this.activeSession || this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    this.clearRollover();
    this.reconnecting = true;
    const signal = this.connectionController.signal;
    try {
      const replacement = await this.connectWithRefreshRetry(true, "recovery", signal);
      if (this.stopping) {
        await this.closeSession(replacement, false);
        return;
      }
      if (this.activeSession) {
        await this.closeSession(replacement, false);
        return;
      }
      await this.activateSession(replacement);
    } catch (error) {
      if (signal.aborted) return;
      const failure = error instanceof RendererTransportError
        ? error
        : new RendererTransportError("Dictation reconnection failed.", code);
      await this.reportFailure(failure.code);
      this.clearPendingFrames();
    } finally {
      this.reconnecting = false;
      this.recoveryInFlight = false;
    }
  }

  private async closeSession(
    session: TransportSession,
    graceful: boolean,
  ): Promise<void> {
    session.expectedClose = true;
    const socket = session.socket;
    if (!graceful || socket.readyState !== WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        // The session is already detached.
      }
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session.closeResolver === finish) session.closeResolver = null;
        resolve();
      };
      session.closeResolver = finish;
      const timer = setTimeout(() => {
        socket.close();
        finish();
      }, SESSION_CLOSE_TIMEOUT_MS);
      socket.send(JSON.stringify({ type: "session.close" }));
    });
    try {
      socket.close();
    } catch {
      // The close handshake already completed.
    }
  }

  private async reportFailure(code: DictationTransportFailureCode): Promise<void> {
    try {
      await ipcRenderer.invoke("voice:dictation-failed", code);
    } catch {
      // Capture is already failing closed.
    }
  }

  private scheduleRollover(delay = SESSION_ROLLOVER_MS): void {
    this.clearRollover();
    this.rolloverTimer = setTimeout(() => {
      void this.performRollover();
    }, delay);
  }

  private clearRollover(): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    this.rolloverTimer = null;
  }

  private queueFrame(buffer: ArrayBuffer): void {
    const maximumBytes = Math.round(this.sampleRate * 2 * (
      this.starting ? STARTUP_AUDIO_BUFFER_MS / 1_000 : 2
    ));
    if (this.starting && this.pendingBytes + buffer.byteLength > maximumBytes) {
      this.dispose();
      void this.reportFailure("session-timeout");
      return;
    }
    const copy = buffer.slice(0);
    this.pendingFrames.push(copy);
    this.pendingBytes += copy.byteLength;
    while (this.pendingBytes > maximumBytes && this.pendingFrames.length > 0) {
      this.pendingBytes -= this.pendingFrames.shift()?.byteLength ?? 0;
    }
  }

  private flushPendingFrames(): void {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    this.pendingBytes = 0;
    const session = this.activeSession;
    if (!session?.started || session.socket.readyState !== WebSocket.OPEN) return;
    for (const frame of frames) {
      session.socket.send(JSON.stringify({ type: "audio.append", audio: toBase64(frame) }));
    }
  }

  private clearPendingFrames(): void {
    this.pendingFrames = [];
    this.pendingBytes = 0;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const current = this.operation.then(task, task);
    this.operation = current.then(() => undefined, () => undefined);
    return current;
  }
}
