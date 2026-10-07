import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const ipcRenderer = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({ ipcRenderer }));

import { RendererDictationTransport } from "../electron/RendererDictationTransport";

import { FakeWebSocket, sockets } from "./support/fake-websocket";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function startEvent(id: string): Record<string, unknown> {
  return {
    type: "session.started",
    session: {
      session_id: id,
      status: "active",
      config: {
        provider_mode: "streaming_sse",
        transcript_delivery_mode: "segment",
      },
    },
  };
}

describe("RendererDictationTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    ipcRenderer.invoke.mockReset();
    ipcRenderer.send.mockReset();
    ipcRenderer.invoke.mockImplementation((channel: string, request?: unknown) => {
      if (channel === "voice:prepare-dictation") {
        return Promise.resolve({
          connection: {
            websocketUrl: "wss://example.test/dictation",
            protocols: ["chatgpt-dictation", "openai-bearer.test", "codex-desktop"],
            sessionStart: { type: "session.start", config: {} },
          },
          snapshot: {},
          request,
        });
      }
      return Promise.resolve({});
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("preserves the beginning of speech during a connection longer than two seconds", async () => {
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 16_000, targetMode: "live" });
    const frames = [1, 2, 3, 4].map((value) => new Uint8Array(32_000).fill(value).buffer);
    for (const frame of frames) transport.sendAudio(frame);
    await flushPromises();
    sockets[0]!.open();
    sockets[0]!.message(startEvent("session-1"));
    await starting;
    const audio = sockets[0]!.sent.map((value) => JSON.parse(value))
      .filter((event) => event.type === "audio.append");
    expect(audio).toHaveLength(4);
    expect(audio.map((event) => atob(event.audio).charCodeAt(0))).toEqual([1, 2, 3, 4]);
    transport.dispose();
  });

  it("cancels an opening socket immediately when no speech has been captured", async () => {
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 48_000 });
    const cancelled = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await flushPromises();
    await transport.stop();
    await cancelled;
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    expect(sockets[0]!.sent).toEqual([]);
    expect(ipcRenderer.invoke.mock.calls.filter(([channel]) => channel === "voice:prepare-dictation")).toHaveLength(1);
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith("voice:dictation-failed", expect.anything());

    const restarted = transport.start({ sampleRate: 48_000 });
    await flushPromises();
    sockets[1]!.open();
    sockets[1]!.message(startEvent("session-2"));
    await restarted;
    expect(sockets[1]!.sent.some((value) => value.includes("audio.append"))).toBe(false);
    transport.dispose();
  });

  it("delivers captured speech when Fn is released before the server connects", async () => {
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 48_000 });
    await flushPromises();
    transport.sendAudio(new Uint8Array([1, 2]).buffer);
    const stopping = transport.stop();
    transport.sendAudio(new Uint8Array([3, 4]).buffer);
    sockets[0]!.open();
    sockets[0]!.message(startEvent("session-1"));
    await starting;
    await flushPromises();
    const events = sockets[0]!.sent.map((value) => JSON.parse(value));
    expect(events.map((event) => event.type)).toEqual(["session.start", "audio.append", "session.close"]);
    expect(atob(events[1]!.audio)).toBe(String.fromCharCode(1, 2));
    sockets[0]!.message({ type: "transcript.final", utterance_id: "utterance-1", text: "짧은 발화" });
    expect(ipcRenderer.send).toHaveBeenCalledWith("voice:dictation-event", expect.objectContaining({ type: "transcript.final" }));
    sockets[0]!.message({ type: "session.updated", session: { status: "closed" } });
    await stopping;
    transport.dispose();
  });

  it("ignores a late authentication response after stop", async () => {
    const prepare = ipcRenderer.invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    ipcRenderer.invoke.mockImplementation((channel: string, request?: unknown) => {
      if (channel === "voice:prepare-dictation") {
        return new Promise((resolve) => { finish = resolve; });
      }
      return prepare(channel, request);
    });
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 48_000 });
    const cancelled = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await flushPromises();
    await transport.stop();
    await cancelled;
    finish(await prepare("voice:prepare-dictation"));
    await flushPromises();
    expect(sockets).toHaveLength(0);
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith("voice:dictation-started");
    transport.dispose();
  });

  it("fails explicitly when startup audio exceeds its bounded buffer", async () => {
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 16_000 });
    const cancelled = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await flushPromises();
    transport.sendAudio(new Uint8Array(16_000 * 2 * 31).buffer);
    await cancelled;
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("voice:dictation-failed", "session-timeout");
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    expect(sockets[0]!.sent).toEqual([]);
    transport.dispose();
  });

  it("keeps audio on the old socket until a replacement is ready", async () => {
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 48_000, targetMode: "live" });
    await flushPromises();

    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.message(startEvent("session-1"));
    await starting;
    sockets[0]!.message({ type: "speech.started", utterance_id: "utterance-1" });

    vi.advanceTimersByTime(270_000);
    await flushPromises();
    expect(sockets).toHaveLength(2);

    transport.sendAudio(new Uint8Array([1, 2]).buffer);
    expect(sockets[0]!.sent.at(-1)).toContain("audio.append");
    expect(sockets[1]!.sent).toEqual([]);

    sockets[1]!.open();
    sockets[1]!.message(startEvent("session-2"));
    await flushPromises();
    transport.sendAudio(new Uint8Array([3, 4]).buffer);

    expect(sockets[0]!.sent.at(-1)).toContain("audio.append");
    expect(sockets[1]!.sent.some((value) => value.includes("audio.append"))).toBe(false);

    sockets[0]!.message({
      type: "transcript.final",
      utterance_id: "utterance-1",
      revision: 1,
      text: "발화 경계",
    });
    await flushPromises();
    transport.sendAudio(new Uint8Array([3, 4]).buffer);

    expect(sockets[0]!.sent.some((value) => value.includes("session.close"))).toBe(true);
    expect(sockets[1]!.sent.at(-1)).toContain("audio.append");
    const plannedRequest = ipcRenderer.invoke.mock.calls
      .filter(([channel]) => channel === "voice:prepare-dictation")
      .at(-1)?.[1] as { reconnectMode?: string };
    expect(plannedRequest.reconnectMode).toBe("planned");

    transport.dispose();
  });

  it("buffers audio while recovering an unexpected disconnect", async () => {
    const transport = new RendererDictationTransport();
    const starting = transport.start({ sampleRate: 48_000, targetMode: "live" });
    await flushPromises();
    sockets[0]!.open();
    sockets[0]!.message(startEvent("session-1"));
    await starting;

    sockets[0]!.close();
    transport.sendAudio(new Uint8Array([7, 8]).buffer);
    await flushPromises();
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    sockets[1]!.message(startEvent("session-2"));
    await flushPromises();

    expect(sockets[1]!.sent.some((value) => value.includes("audio.append"))).toBe(true);
    const recoveryRequest = ipcRenderer.invoke.mock.calls
      .filter(([channel]) => channel === "voice:prepare-dictation")
      .at(-1)?.[1] as { reconnectMode?: string };
    expect(recoveryRequest.reconnectMode).toBe("recovery");

    transport.dispose();
  });
});
