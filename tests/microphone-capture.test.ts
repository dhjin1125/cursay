import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrophoneCapture } from "../src/audio/MicrophoneCapture";
import { createInitialSnapshot } from "../shared/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

const contexts: FakeAudioContext[] = [];
const worklets: FakeAudioWorkletNode[] = [];
let moduleReady: Promise<void>;

class FakeAudioContext {
  state = "running";
  sampleRate = 44_100;
  audioWorklet = { addModule: vi.fn(() => moduleReady) };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  suspend = vi.fn(async () => { this.state = "suspended"; });
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { contexts.push(this); }
}

class FakeAudioWorkletNode {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    close: vi.fn(),
  };
  disconnect = vi.fn();
  constructor() { worklets.push(this); }
}

function setup() {
  const snapshot = createInitialSnapshot();
  const api = {
    start: vi.fn(async () => snapshot),
    stop: vi.fn(async () => snapshot),
    sendAudio: vi.fn(),
    sendMicrophoneLevel: vi.fn(),
  };
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const capture = new MicrophoneCapture(api, vi.fn());
  return { capture, api, getUserMedia, track, stream, snapshot };
}

describe("Microphone capture startup", () => {
  beforeEach(() => {
    contexts.length = 0;
    worklets.length = 0;
    moduleReady = Promise.resolve();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("prepares and suspends audio processing without opening the microphone or server", async () => {
    const { capture, api, getUserMedia } = setup();
    await capture.prepare();
    expect(contexts[0]!.state).toBe("suspended");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(worklets).toHaveLength(0);
    capture.dispose();
  });

  it("records and forwards the first frame while the server is still connecting", async () => {
    const { capture, api, snapshot } = setup();
    const connection = deferred<typeof snapshot>();
    api.start.mockReturnValueOnce(connection.promise);
    await capture.prepare();
    const recording = vi.fn();
    const start = capture.start({ targetMode: "live" }, recording);
    await flushPromises();
    expect(recording).toHaveBeenCalledOnce();
    expect(api.start).toHaveBeenCalledWith({ targetMode: "live", sampleRate: 44_100 });
    const bytes = new Uint8Array([1, 2]).buffer;
    worklets[0]!.port.onmessage!({ data: { type: "frame", bytes } });
    expect(api.sendAudio).toHaveBeenCalledWith(bytes);
    connection.resolve(snapshot);
    await start;
    capture.dispose();
  });

  it("opens the microphone and server in parallel and reuses the prepared context", async () => {
    const { capture, api, getUserMedia, stream } = setup();
    await capture.prepare();
    const microphone = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(microphone.promise);
    const start = capture.start({}, vi.fn());
    expect(getUserMedia).toHaveBeenCalledOnce();
    await flushPromises();
    expect(api.start).toHaveBeenCalledOnce();
    microphone.resolve(stream);
    await start;
    await capture.stop();
    await capture.start({}, vi.fn());
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.audioWorklet.addModule).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("stops the microphone immediately without waiting for the connection", async () => {
    const { capture, api, track, snapshot } = setup();
    const connection = deferred<typeof snapshot>();
    const stopped = deferred<typeof snapshot>();
    api.start.mockReturnValueOnce(connection.promise);
    api.stop.mockReturnValueOnce(stopped.promise);
    const recording = vi.fn();
    const start = capture.start({}, recording);
    await flushPromises();
    const staleMessage = worklets[0]!.port.onmessage!;
    const stop = capture.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledOnce();
    staleMessage({ data: { type: "frame", bytes: new Uint8Array([1, 2]).buffer } });
    expect(api.sendAudio).not.toHaveBeenCalled();
    stopped.resolve(snapshot);
    await stop;
    connection.resolve(snapshot);
    await start;
    expect(recording).toHaveBeenCalledOnce();
    expect(contexts[0]!.state).toBe("suspended");
    capture.dispose();
  });

  it("releases a late microphone stream without reviving a stopped session", async () => {
    const { capture, getUserMedia, stream, track } = setup();
    const microphone = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(microphone.promise);
    const recording = vi.fn();
    const start = capture.start({}, recording);
    await flushPromises();
    await capture.stop();
    microphone.resolve(stream);
    await start;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recording).not.toHaveBeenCalled();
    expect(worklets).toHaveLength(0);
    capture.dispose();
  });

  it("does not open a connection when stopped during worklet preparation", async () => {
    const module = deferred<void>();
    moduleReady = module.promise;
    const { capture, api, track } = setup();
    const recording = vi.fn();
    const start = capture.start({}, recording);
    await flushPromises();
    await capture.stop();
    module.resolve();
    await start;
    expect(api.start).not.toHaveBeenCalled();
    expect(recording).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("releases a late microphone stream after an early connection failure", async () => {
    const { capture, api, getUserMedia, stream, track } = setup();
    const microphone = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(microphone.promise);
    api.start.mockRejectedValueOnce(new Error("Connection failed"));
    const recording = vi.fn();
    await expect(capture.start({}, recording)).rejects.toThrow("Connection failed");
    microphone.resolve(stream);
    await flushPromises();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recording).not.toHaveBeenCalled();
    expect(api.stop).toHaveBeenCalledOnce();
    capture.dispose();
  });

  it("releases media after microphone denial and can start again", async () => {
    const { capture, getUserMedia } = setup();
    getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(capture.start({}, vi.fn())).rejects.toThrow("Permission denied");
    const recording = vi.fn();
    await capture.start({}, recording);
    expect(recording).toHaveBeenCalledOnce();
    capture.dispose();
  });
});
