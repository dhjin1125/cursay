import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import type {
  AccessibilityState,
  CaptureTargetMode,
  CommandDefinition,
  PushToTalkEvent,
  TargetBindingEvent,
  TargetBindingInvalidReason,
  TargetBindingState,
} from "../../shared/contracts.js";

interface HelperResponse {
  id: string;
  ok: boolean;
  trusted?: boolean;
  version?: string;
  fnMonitorAvailable?: boolean;
  text?: string;
  targetBundleId?: string;
  targetContextId?: string;
  targetDisplayName?: string;
  targetBundlePath?: string;
  targetBinding?: TargetBindingState;
  error?: string;
}

export interface CapturedField {
  targetBundleId: string;
  targetContextId: string;
}

export function parseRefinementCancellation(value: unknown, now = Date.now()): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; targetContextId?: unknown; timestampMs?: unknown };
  return event.type === "refinementCancelled" &&
    typeof event.targetContextId === "string" &&
    TARGET_CONTEXT_PATTERN.test(event.targetContextId) &&
    typeof event.timestampMs === "number" &&
    Number.isFinite(event.timestampMs) &&
    Math.abs(now - event.timestampMs) <= 5_000
    ? event.targetContextId.toLowerCase() : null;
}

interface HelperFunctionKeyEvent {
  type: "functionKey";
  state: "down" | "up";
  targetMode?: "live" | "pinned";
  targetBundleId?: string | null;
  targetContextId?: string | null;
  targetDisplayName?: string | null;
  targetBundlePath?: string | null;
  targetBinding?: TargetBindingState;
  timestampMs: number;
}

interface HelperTargetBindingEvent {
  type: "targetBinding";
  targetContextId?: string | null;
  binding?: TargetBindingState;
  reason?: TargetBindingInvalidReason;
  timestampMs: number;
}

type HelperBridgeEvent = HelperFunctionKeyEvent | HelperTargetBindingEvent;

const TARGET_CONTEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePushToTalkBridgeEvent(
  value: unknown,
  now = Date.now(),
): PushToTalkEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Partial<HelperFunctionKeyEvent>;
  if (
    event.type !== "functionKey" ||
    (event.state !== "down" && event.state !== "up") ||
    (event.targetMode !== "live" && event.targetMode !== "pinned") ||
    typeof event.timestampMs !== "number" ||
    !Number.isFinite(event.timestampMs) ||
    Math.abs(now - event.timestampMs) > 5_000
  ) {
    return null;
  }
  if (
    event.targetContextId !== undefined &&
    event.targetContextId !== null &&
    (typeof event.targetContextId !== "string" ||
      !TARGET_CONTEXT_PATTERN.test(event.targetContextId))
  ) {
    return null;
  }
  const displayName = typeof event.targetDisplayName === "string"
    ? event.targetDisplayName.trim().slice(0, 120)
    : null;
  if (displayName && /[\u0000-\u001f\u007f]/u.test(displayName)) return null;
  const bundlePath = typeof event.targetBundlePath === "string"
    ? event.targetBundlePath
    : null;
  if (
    bundlePath &&
    (!bundlePath.startsWith("/") ||
      bundlePath.length > 4_096 ||
      bundlePath.includes("\0") ||
      !bundlePath.endsWith(".app"))
  ) {
    return null;
  }
  const binding: TargetBindingState = event.targetContextId
    ? event.targetBinding === "background" ? "background" : "foreground"
    : "none";
  return {
    state: event.state,
    targetMode: event.targetMode,
    targetBundleId: typeof event.targetBundleId === "string"
      ? event.targetBundleId.slice(0, 240)
      : null,
    targetContextId: typeof event.targetContextId === "string"
      ? event.targetContextId.toLowerCase()
      : null,
    targetDisplayName: displayName,
    targetBundlePath: bundlePath,
    targetBinding: binding,
    timestampMs: event.timestampMs,
  };
}

export function parseTargetBindingBridgeEvent(
  value: unknown,
  now = Date.now(),
): TargetBindingEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Partial<HelperTargetBindingEvent>;
  const bindings: TargetBindingEvent["binding"][] = [
    "foreground",
    "background",
    "rebinding",
    "invalid",
  ];
  if (
    event.type !== "targetBinding" ||
    typeof event.targetContextId !== "string" ||
    !TARGET_CONTEXT_PATTERN.test(event.targetContextId) ||
    !bindings.includes(event.binding as TargetBindingEvent["binding"]) ||
    typeof event.timestampMs !== "number" ||
    !Number.isFinite(event.timestampMs) ||
    Math.abs(now - event.timestampMs) > 5_000
  ) {
    return null;
  }
  const reason = event.reason === "process-terminated" ||
      event.reason === "input-unavailable"
    ? event.reason
    : null;
  if (event.binding === "invalid" && reason === null) return null;
  return {
    targetContextId: event.targetContextId.toLowerCase(),
    binding: event.binding as TargetBindingEvent["binding"],
    reason: event.binding === "invalid" ? reason : null,
    timestampMs: event.timestampMs,
  };
}

interface PendingHelperRequest {
  resolve(value: HelperResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class ActionBridge extends EventEmitter {
  private socket: Socket | null = null;
  private server: Server | null = null;
  private connectionPromise: Promise<void> | null = null;
  private responseBuffer = "";
  private readonly pending = new Map<string, PendingHelperRequest>();

  constructor(private readonly helperAppPath: string) {
    super();
  }

  async status(): Promise<{
    state: AccessibilityState;
    version: string | null;
    fnMonitorAvailable: boolean;
  }> {
    try {
      const response = await this.request({ type: "status" });
      return {
        state: response.trusted ? "trusted" : "denied",
        version: response.version ?? null,
        fnMonitorAvailable: response.fnMonitorAvailable === true,
      };
    } catch {
      return { state: "unavailable", version: null, fnMonitorAvailable: false };
    }
  }

  async refreshStatus(): Promise<{
    state: AccessibilityState;
    version: string | null;
    fnMonitorAvailable: boolean;
  }> {
    await this.restart();
    return this.status();
  }

  async requestAccessibility(): Promise<AccessibilityState> {
    try {
      const response = await this.request({ type: "requestAccessibility" });
      return response.trusted ? "trusted" : "denied";
    } catch {
      return "unavailable";
    }
  }

  async captureRefinementTarget(): Promise<CapturedField> {
    return this.captureTarget(true);
  }

  async captureTarget(frozen = false): Promise<{
    targetBundleId: string;
    targetContextId: string;
    targetDisplayName: string | null;
    targetBundlePath: string | null;
    targetBinding: "foreground";
  }> {
    const response = await this.request({
      type: frozen ? "captureRefinementTarget" : "captureTarget",
      timestampMs: Date.now(),
    });
    if (
      !response.ok ||
      typeof response.targetBundleId !== "string" ||
      response.targetBundleId.length === 0 ||
      response.targetBundleId.length > 240 ||
      typeof response.targetContextId !== "string" ||
      !TARGET_CONTEXT_PATTERN.test(response.targetContextId)
    ) {
      throw new Error(response.error ?? "The focused field could not be pinned.");
    }
    const targetDisplayName = typeof response.targetDisplayName === "string"
      ? response.targetDisplayName.trim().slice(0, 120)
      : null;
    const targetBundlePath = typeof response.targetBundlePath === "string" &&
        response.targetBundlePath.startsWith("/") &&
        response.targetBundlePath.length <= 4_096 &&
        !response.targetBundlePath.includes("\0") &&
        response.targetBundlePath.endsWith(".app")
      ? response.targetBundlePath
      : null;
    return {
      targetBundleId: response.targetBundleId,
      targetContextId: response.targetContextId.toLowerCase(),
      targetDisplayName,
      targetBundlePath,
      targetBinding: "foreground",
    };
  }

  async insertText(
    text: string,
    targetBundleIds: string[],
    targetContextId?: string,
    targetMode: CaptureTargetMode = "configured",
  ): Promise<void> {
    if (!text || text.length > 10_000) throw new Error("Text insertion payload is invalid.");
    const response = await this.request({
      type: "insertText",
      text,
      targetBundleIds,
      targetContextId,
      targetMode,
      timestampMs: Date.now(),
    });
    if (!response.ok) throw new Error(response.error ?? "Text insertion was blocked.");
  }

  async beginRefinement(target: CapturedField): Promise<string> {
    const response = await this.request({
      type: "beginRefinement",
      targetBundleIds: [target.targetBundleId],
      targetContextId: target.targetContextId,
      timestampMs: Date.now(),
    });
    if (!response.ok || typeof response.text !== "string") {
      throw new Error(response.error ?? "The input field could not be locked for Refine.");
    }
    return response.text;
  }

  async applyRefinement(target: CapturedField, expectedText: string, text: string): Promise<void> {
    if (text.length > 50_000) throw new Error("The refined field exceeds 50,000 characters. Your text was kept.");
    const response = await this.request({
      type: "applyRefinement",
      text,
      expectedText,
      targetBundleIds: [target.targetBundleId],
      targetContextId: target.targetContextId,
      timestampMs: Date.now(),
    });
    if (!response.ok) throw new Error(response.error ?? "Refine could not update the input field.");
  }

  async endRefinement(target: CapturedField): Promise<void> {
    const response = await this.request({
      type: "endRefinement",
      targetContextId: target.targetContextId,
      timestampMs: Date.now(),
    });
    if (!response.ok) throw new Error(response.error ?? "The input field could not be unlocked.");
  }

  async readText(
    targetBundleIds: string[],
    targetContextId: string,
  ): Promise<string> {
    const response = await this.request({
      type: "readText",
      targetBundleIds,
      targetContextId,
      timestampMs: Date.now(),
    });
    if (!response.ok || typeof response.text !== "string") {
      throw new Error(response.error ?? "Target text could not be read.");
    }
    return response.text;
  }

  async replaceText(
    text: string,
    targetBundleIds: string[],
    targetContextId: string,
  ): Promise<void> {
    if (text.length > 10_000) throw new Error("Text replacement payload is invalid.");
    const response = await this.request({
      type: "replaceText",
      text,
      targetBundleIds,
      targetContextId,
      timestampMs: Date.now(),
    });
    if (!response.ok) throw new Error(response.error ?? "Target text could not be replaced.");
  }

  async execute(
    command: CommandDefinition,
    targetBundleIds = command.targetBundleIds,
    targetContextId?: string,
    targetMode: CaptureTargetMode = "configured",
  ): Promise<void> {
    const response = await this.request({
      type: "hotkey",
      key: command.action.key,
      modifiers: command.action.modifiers,
      targetBundleIds,
      targetContextId,
      targetMode,
      timestampMs: Date.now(),
    });
    if (!response.ok) throw new Error(response.error ?? "Voice command was blocked.");
  }

  async releaseTarget(targetContextId: string): Promise<void> {
    if (!TARGET_CONTEXT_PATTERN.test(targetContextId)) return;
    const response = await this.request({
      type: "releaseTarget",
      targetContextId,
      timestampMs: Date.now(),
    });
    if (!response.ok) throw new Error(response.error ?? "Captured target release failed.");
  }

  async dispose(): Promise<void> {
    await this.restart();
  }

  private async restart(): Promise<void> {
    this.connectionPromise = null;
    const socket = this.socket;
    const server = this.server;
    this.socket = null;
    this.server = null;
    this.responseBuffer = "";
    socket?.destroy();
    server?.close();
    this.rejectPending("Action helper restarted.");
    if (socket) this.emit("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  private async ensureConnection(): Promise<void> {
    if (this.socket?.writable && !this.socket.destroyed) return;
    if (!this.connectionPromise) {
      this.connectionPromise = this.launchStandaloneHelper().finally(() => {
        this.connectionPromise = null;
      });
    }
    await this.connectionPromise;
  }

  private async launchStandaloneHelper(): Promise<void> {
    await access(this.helperAppPath);
    const token = randomBytes(32).toString("hex");
    const server = net.createServer();
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = () => reject(new Error("Action bridge could not open a loopback listener."));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (!address) throw new Error("Action bridge did not receive a loopback port.");

    const connected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Action helper did not connect in time."));
      }, 6_000);

      server.on("connection", (candidate) => {
        this.acceptCandidate(candidate, token, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    });

    const launcher = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-j",
        this.helperAppPath,
        "--args",
        "--connect-port",
        String(address.port),
        "--token",
        token,
      ],
      { stdio: "ignore" },
    );
    launcher.unref();

    try {
      await connected;
    } finally {
      server.close();
      if (this.server === server) this.server = null;
    }
  }

  private acceptCandidate(candidate: Socket, token: string, accepted: () => void): void {
    candidate.setEncoding("utf8");
    candidate.setNoDelay(true);
    let handshakeBuffer = "";

    const onHandshake = (chunk: string) => {
      handshakeBuffer += chunk;
      const newline = handshakeBuffer.indexOf("\n");
      if (newline < 0) return;
      candidate.removeListener("data", onHandshake);
      const line = handshakeBuffer.slice(0, newline).trim();
      let hello: { type?: unknown; token?: unknown };
      try {
        hello = JSON.parse(line) as typeof hello;
      } catch {
        candidate.destroy();
        return;
      }
      if (hello.type !== "hello" || hello.token !== token || this.socket) {
        candidate.destroy();
        return;
      }

      this.socket = candidate;
      candidate.on("data", (data: string) => this.consumeResponses(data));
      candidate.once("close", () => this.handleDisconnect(candidate));
      candidate.once("error", () => this.handleDisconnect(candidate));
      const remainder = handshakeBuffer.slice(newline + 1);
      if (remainder) this.consumeResponses(remainder);
      accepted();
    };

    candidate.on("data", onHandshake);
  }

  private async request(payload: Record<string, unknown>): Promise<HelperResponse> {
    await this.ensureConnection();
    const socket = this.socket;
    if (!socket?.writable || socket.destroyed) throw new Error("Action helper is unavailable.");
    const id = randomUUID();
    const result = new Promise<HelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Action helper timed out."));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    return result;
  }

  private consumeResponses(chunk: string): void {
    this.responseBuffer += chunk;
    while (true) {
      const newline = this.responseBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.responseBuffer.slice(0, newline).trim();
      this.responseBuffer = this.responseBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as HelperResponse | HelperBridgeEvent;
        const refinementCancelled = parseRefinementCancellation(message);
        if (refinementCancelled) {
          this.emit("refinement-cancelled", refinementCancelled);
          continue;
        }
        const event = parsePushToTalkBridgeEvent(message);
        if (event) {
          this.emit("push-to-talk", event);
          continue;
        }
        const targetBinding = parseTargetBindingBridgeEvent(message);
        if (targetBinding) {
          this.emit("target-binding", targetBinding);
          continue;
        }
        if (!("id" in message) || typeof message.id !== "string" || !("ok" in message)) {
          continue;
        }
        const response = message as HelperResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
      } catch {
        // Ignore malformed helper output without echoing it to logs.
      }
    }
  }

  private handleDisconnect(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.responseBuffer = "";
    this.rejectPending("Action helper disconnected.");
    this.emit("disconnected");
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
