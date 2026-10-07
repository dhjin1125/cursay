import type { StartListeningRequest, VoiceControlApi } from "@shared/contracts";

export type MicrophoneRequest = Omit<StartListeningRequest, "sampleRate">;

export interface CaptureMicrophone {
  start(request: MicrophoneRequest, onRecording: () => void): Promise<void>;
  stop(): Promise<unknown>;
}

interface CaptureAttempt {
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  connection: Promise<unknown> | null;
}

type CaptureApi = Pick<VoiceControlApi, "start" | "stop" | "sendAudio" | "sendMicrophoneLevel">;

export class MicrophoneCapture implements CaptureMicrophone {
  private context: AudioContext | null = null;
  private prepared: Promise<AudioContext> | null = null;
  private attempt: CaptureAttempt | null = null;
  private disposed = false;

  constructor(
    private readonly api: CaptureApi,
    private readonly onLevel: (value: number) => void,
  ) {}

  async prepare(): Promise<AudioContext> {
    if (this.disposed) return Promise.reject(new Error("Microphone capture is closed."));
    if (this.context?.state === "closed") this.prepared = null;
    if (this.prepared) return this.prepared;

    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    this.prepared = Promise.all([
      context.suspend(),
      context.audioWorklet.addModule("./pcm16-worklet.js"),
    ]).then(() => context).catch((error) => {
      if (this.context === context) {
        this.context = null;
        this.prepared = null;
      }
      if (context.state !== "closed") void context.close().catch(() => undefined);
      throw error;
    });
    return this.prepared;
  }

  async start(request: MicrophoneRequest, onRecording: () => void): Promise<void> {
    if (this.disposed) throw new Error("Microphone capture is closed.");
    if (this.attempt) throw new Error("Microphone capture is already active.");
    const attempt: CaptureAttempt = { stream: null, source: null, worklet: null, connection: null };
    this.attempt = attempt;
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      }).then((stream) => {
        if (this.attempt !== attempt) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("Microphone capture was cancelled.");
        }
        attempt.stream = stream;
        return stream;
      });
      const prepared = this.prepare();
      attempt.connection = prepared.then((context) => {
        if (this.attempt !== attempt) throw new Error("Microphone capture was cancelled.");
        return this.api.start({ ...request, sampleRate: context.sampleRate });
      });
      const contextPromise = prepared.then(async (context) => {
        if (this.attempt !== attempt) throw new Error("Microphone capture was cancelled.");
        await context.resume();
        return context;
      });
      const recording = Promise.all([streamPromise, contextPromise]).then(([stream, context]) => {
        if (this.attempt !== attempt) return;
        const source = context.createMediaStreamSource(stream);
        attempt.source = source;
        const worklet = new AudioWorkletNode(context, "pcm16-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        attempt.worklet = worklet;
        worklet.port.onmessage = (event: MessageEvent<unknown>) => {
          if (this.attempt !== attempt) return;
          const payload = event.data as { type?: string; bytes?: ArrayBuffer; value?: number };
          if (payload.type === "frame" && payload.bytes instanceof ArrayBuffer) {
            this.api.sendAudio(payload.bytes);
          } else if (payload.type === "level" && typeof payload.value === "number") {
            this.publishLevel(Math.max(0, Math.min(1, payload.value)));
          }
        };
        source.connect(worklet);
        onRecording();
      });
      await Promise.all([recording, attempt.connection]);
    } catch (error) {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      this.release(attempt);
      if (this.context?.state !== "closed") void this.context?.suspend().catch(() => undefined);
      if (attempt.connection) void this.api.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<unknown> {
    const attempt = this.attempt;
    this.attempt = null;
    this.release(attempt);
    const suspension = this.context && this.context.state !== "closed"
      ? this.context.suspend()
      : Promise.resolve();
    const [, snapshot] = await Promise.all([suspension, this.api.stop()]);
    return snapshot;
  }

  dispose(): void {
    this.disposed = true;
    const attempt = this.attempt;
    this.attempt = null;
    this.release(attempt);
    if (this.context && this.context.state !== "closed") {
      void this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.prepared = null;
  }

  private release(attempt: CaptureAttempt | null): void {
    if (attempt?.worklet) {
      attempt.worklet.port.onmessage = null;
      attempt.worklet.port.close();
      attempt.worklet.disconnect();
    }
    attempt?.source?.disconnect();
    attempt?.stream?.getTracks().forEach((track) => track.stop());
    this.publishLevel(0);
  }

  private publishLevel(value: number): void {
    this.onLevel(value);
    this.api.sendMicrophoneLevel(value);
  }
}
