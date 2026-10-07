import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, sockets } from "./support/fake-websocket";
import { VoiceController } from "../electron/services/VoiceController";
import type { SettingsStore } from "../electron/services/SettingsStore";
import { POST_EDIT_TIMEOUT_MS, PostEditTimeoutError, type CodexAuthBroker } from "../electron/services/CodexAuthBroker";
import type { ActionBridge, CapturedField } from "../electron/services/ActionBridge";
import { DEFAULT_SETTINGS, type DictationPrepareRequest, type SettingsPatch } from "../shared/contracts";

const ipcRenderer = vi.hoisted(() => ({ invoke: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer }));
import { RendererDictationTransport } from "../electron/RendererDictationTransport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

const first: CapturedField = { targetBundleId: "com.apple.TextEdit", targetContextId: "123e4567-e89b-42d3-a456-426614174000" };
const second: CapturedField = { targetBundleId: "com.openai.codex", targetContextId: "123e4567-e89b-42d3-a456-426614174001" };
const cleanup: Array<() => Promise<void>> = [];

async function setup(targetMode: "live" | "pinned" = "live", postEditEnabled = true) {
  const refinement = deferred<string>();
  const refining = deferred<AbortSignal>();
  let settingsValue = { ...structuredClone(DEFAULT_SETTINGS), postEditEnabled, commands: [] };
  const settings = {
    get: () => structuredClone(settingsValue),
    patch: async (patch: SettingsPatch) => (settingsValue = { ...settingsValue, ...patch } as typeof settingsValue),
  };
  const auth = Object.assign(new EventEmitter(), {
    getToken: async () => "test-token",
    postEdit: vi.fn((_text: string, signal: AbortSignal, _model?: string, _effort?: string) => {
      refining.resolve(signal);
      // The controller must also reject a late response from an uncooperative provider.
      return refinement.promise;
    }),
    dispose: async () => undefined,
  });
  const fields = new Map([[first.targetContextId, "직접 입력한 메모\n"], [second.targetContextId, "다른 필드의 기존 문장\n"]]);
  const state = { focused: first, locked: null as string | null };
  const actions = Object.assign(new EventEmitter(), {
    captureRefinementTarget: vi.fn(async () => ({ ...state.focused })),
    insertText: vi.fn(async (text: string, _targets: string[], context?: string, _mode?: string) => {
      const id = context ?? state.focused.targetContextId;
      fields.set(id, (fields.get(id) ?? "") + text);
    }),
    beginRefinement: vi.fn(async (target: CapturedField) => {
      state.locked = target.targetContextId;
      return fields.get(target.targetContextId)!;
    }),
    applyRefinement: vi.fn(async (target: CapturedField, expected: string, text: string) => {
      if (state.locked !== target.targetContextId || fields.get(target.targetContextId) !== expected) {
        throw new Error("The field changed while refining. Your changes were kept.");
      }
      fields.set(target.targetContextId, text);
    }),
    endRefinement: vi.fn(async (target: CapturedField) => {
      if (state.locked === target.targetContextId) state.locked = null;
    }),
    releaseTarget: vi.fn(async (_context: string) => undefined),
    dispose: async () => undefined,
  });
  const controller = new VoiceController(settings as unknown as SettingsStore, auth as unknown as CodexAuthBroker, actions as unknown as ActionBridge);
  ipcRenderer.invoke.mockImplementation((channel: string, request: DictationPrepareRequest) => {
    if (channel === "voice:prepare-dictation") return controller.prepareDictation(request);
    if (channel === "voice:dictation-started") return controller.markDictationStarted();
    if (channel === "voice:stop") return controller.stop();
    if (channel === "voice:finish-dictation") return controller.finishDictation();
    throw new Error(`Unexpected IPC: ${channel}`);
  });
  ipcRenderer.send.mockImplementation((channel: string, event: unknown) => {
    if (channel === "voice:dictation-event") void controller.acceptDictationEvent(event);
  });
  const transport = new RendererDictationTransport();
  cleanup.push(async () => { transport.dispose(); await controller.dispose(); });
  const starting = transport.start({ sampleRate: 48_000, targetMode,
    targetBundleId: targetMode === "pinned" ? first.targetBundleId : undefined,
    targetContextId: targetMode === "pinned" ? first.targetContextId : undefined });
  await flushPromises();
  const socket = sockets[0]!;
  socket.open();
  socket.message({ type: "session.started", session: { session_id: "delivery-test", status: "active", config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" } } });
  await starting;
  const startFinishing = () => {
    controller.prepareToFinish();
    return transport.stop();
  };
  const closeServer = async () => {
    await flushPromises();
    socket.message({ type: "session.updated", session: { status: "closed" } });
    await flushPromises();
  };
  return { transport, controller, socket, actions, auth, refinement, refining, state, fields, startFinishing, closeServer };
}

function segment(socket: FakeWebSocket, text: string, sequence = 1, utterance = "utterance") {
  socket.message({ type: "transcript.segment", sequence_no: sequence, utterance_id: utterance, revision: sequence, text });
}
function final(socket: FakeWebSocket, text: string, sequence = 3, utterance = "utterance") {
  socket.message({ type: "transcript.final", sequence_no: sequence, utterance_id: utterance, revision: sequence, text });
}

describe("Live input followed by whole-field Refine", () => {
  beforeEach(() => {
    sockets.length = 0;
    ipcRenderer.invoke.mockReset();
    ipcRenderer.send.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(async () => {
    for (const dispose of cleanup.splice(0)) await dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([["live", true], ["live", false], ["pinned", true], ["pinned", false]] as const)(
    "streams raw segments and successive utterances without any model call with %s and Refine=%s", async (mode, refine) => {
      const { socket, actions, auth, state } = await setup(mode, refine);
      socket.message({ type: "speech.started", utterance_id: "utterance" });
      segment(socket, "말하는 동안");
      await flushPromises();
      expect(actions.insertText.mock.calls.map(([text]) => text)).toEqual(["말하는 동안"]);
      segment(socket, "말하는 동안 계속 입력", 2);
      await flushPromises();
      expect(actions.insertText.mock.calls.map(([text]) => text)).toEqual(["말하는 동안", " 계속 입력"]);
      final(socket, "말하는 동안 계속 입력");
      segment(socket, "다음 문장", 4, "next");
      final(socket, "다음 문장", 5, "next");
      await flushPromises();
      expect(actions.insertText.mock.calls.map(([text]) => text)).toEqual(["말하는 동안", " 계속 입력", " ", "다음 문장", " "]);
      expect(auth.postEdit).not.toHaveBeenCalled();
      expect(actions.captureRefinementTarget).not.toHaveBeenCalled();
      expect(actions.beginRefinement).not.toHaveBeenCalled();
      expect(state.locked).toBeNull();
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    },
  );

  it("captures the field at Fn stop, drains raw final text, then refines its entire contents once", async () => {
    const c = await setup();
    segment(c.socket, "원본 입력");
    await flushPromises();
    expect(c.auth.postEdit).not.toHaveBeenCalled();
    c.state.focused = second;
    c.fields.set(second.targetContextId, "직접 쓴 문단\n이전에 붙여 넣은 문장\n");
    const stopped = c.startFinishing();
    c.controller.prepareToFinish();
    c.state.focused = first;
    final(c.socket, "원본 입력 마지막 말");
    await flushPromises();
    expect(c.fields.get(second.targetContextId)).toBe("직접 쓴 문단\n이전에 붙여 넣은 문장\n 마지막 말 ");
    expect(c.auth.postEdit).not.toHaveBeenCalled();
    await c.closeServer();
    await c.refining.promise;
    expect(c.state.locked).toBe(second.targetContextId);
    expect(c.actions.captureRefinementTarget).toHaveBeenCalledTimes(1);
    expect(c.auth.postEdit.mock.calls[0]?.[0]).toBe(c.fields.get(second.targetContextId));
    expect(c.controller.getSnapshot().postProcessingState).toBe("correcting");
    c.refinement.resolve("직접 쓴 문단\n이전에 붙여 넣은 문장\n마지막 말.");
    await stopped;
    expect(c.fields.get(second.targetContextId)).toBe("직접 쓴 문단\n이전에 붙여 넣은 문장\n마지막 말.");
    expect(c.fields.get(first.targetContextId)).toBe("직접 입력한 메모\n원본 입력");
    expect(c.auth.postEdit).toHaveBeenCalledTimes(1);
    expect(c.actions.applyRefinement).toHaveBeenCalledTimes(1);
    expect(c.state.locked).toBeNull();
    expect(c.actions.releaseTarget).toHaveBeenCalledExactlyOnceWith(second.targetContextId);
    expect(c.controller.getSnapshot()).toMatchObject({ phase: "disabled", postProcessing: false, postProcessingState: "succeeded" });
  });

  it("refines manually typed text even when no speech was delivered, using the selected model", async () => {
    const c = await setup();
    await c.controller.updateSettings({ postEditModel: "gpt-5.6-terra", postEditReasoningEffort: "high" });
    const stopped = c.startFinishing();
    await c.closeServer();
    const signal = await c.refining.promise;
    expect(c.auth.postEdit).toHaveBeenCalledExactlyOnceWith("직접 입력한 메모\n", signal, "gpt-5.6-terra", "high");
    c.refinement.resolve("직접 입력한 메모\n");
    await stopped;
    expect(c.actions.insertText).not.toHaveBeenCalled();
    expect(c.state.locked).toBeNull();
  });

  it("does not capture, lock, or refine any field when Refine is off", async () => {
    const c = await setup("live", false);
    const stopped = c.startFinishing();
    final(c.socket, "끝까지 원문");
    await c.closeServer();
    await stopped;
    expect(c.fields.get(first.targetContextId)).toBe("직접 입력한 메모\n끝까지 원문 ");
    expect(c.actions.captureRefinementTarget).not.toHaveBeenCalled();
    expect(c.auth.postEdit).not.toHaveBeenCalled();
    expect(c.actions.beginRefinement).not.toHaveBeenCalled();
  });

  it.each(["failure", "timeout", "empty"])("preserves all original text and unlocks on %s", async (outcome) => {
    const c = await setup();
    segment(c.socket, "안녕하새요");
    await flushPromises();
    const stopped = c.startFinishing();
    final(c.socket, "안녕하새요 여러분");
    await c.closeServer();
    await c.refining.promise;
    if (outcome === "empty") c.refinement.resolve("   ");
    else c.refinement.reject(outcome === "timeout" ? new PostEditTimeoutError() : new Error("Provider failed"));
    await stopped;
    expect(c.fields.get(first.targetContextId)).toBe("직접 입력한 메모\n안녕하새요 여러분 ");
    expect(c.actions.applyRefinement).not.toHaveBeenCalled();
    expect(c.state.locked).toBeNull();
    expect(c.controller.getSnapshot().postProcessingState).toBe(outcome === "timeout" ? "timed-out" : "failed");
  });

  it.each(["escape", "button", "disabled", "disconnect"])("unlocks on %s and ignores a late model response", async (source) => {
    const c = await setup();
    const stopped = c.startFinishing();
    await c.closeServer();
    const signal = await c.refining.promise;
    if (source === "escape") c.controller.cancelPendingAction();
    else if (source === "button") c.actions.emit("refinement-cancelled", first.targetContextId);
    else if (source === "disconnect") c.actions.emit("disconnected");
    else await c.controller.updateSettings({ postEditEnabled: false });
    await stopped;
    expect(signal.aborted).toBe(true);
    expect(c.state.locked).toBeNull();
    c.refinement.resolve("늦은 결과");
    await flushPromises();
    expect(c.actions.applyRefinement).not.toHaveBeenCalled();
    expect(c.fields.get(first.targetContextId)).toBe("직접 입력한 메모\n");
  });

  it("releases the field on its deadline even if the provider never settles", async () => {
    const c = await setup();
    vi.useFakeTimers();
    const stopped = c.startFinishing();
    await c.closeServer();
    const signal = await c.refining.promise;
    await vi.advanceTimersByTimeAsync(POST_EDIT_TIMEOUT_MS);
    await stopped;
    expect(signal.aborted).toBe(true);
    expect(c.state.locked).toBeNull();
    expect(c.controller.getSnapshot().postProcessingState).toBe("timed-out");
  });

  it("does not overwrite external edits or retarget to another input", async () => {
    const c = await setup();
    const stopped = c.startFinishing();
    await c.closeServer();
    await c.refining.promise;
    c.state.focused = second;
    c.fields.set(first.targetContextId, "보정 도중 외부에서 수정한 내용");
    c.refinement.resolve("보정한 메모");
    await stopped;
    expect(c.fields.get(first.targetContextId)).toBe("보정 도중 외부에서 수정한 내용");
    expect(c.fields.get(second.targetContextId)).toBe("다른 필드의 기존 문장\n");
    expect(c.state.locked).toBeNull();
    expect(c.controller.getSnapshot().postProcessingState).toBe("failed");
  });

  it("preserves input when no writable field can be captured", async () => {
    const c = await setup();
    c.actions.captureRefinementTarget.mockRejectedValueOnce(new Error("No editable field"));
    const stopped = c.startFinishing();
    await c.closeServer();
    await stopped;
    expect(c.auth.postEdit).not.toHaveBeenCalled();
    expect(c.actions.beginRefinement).not.toHaveBeenCalled();
    expect(c.fields.get(first.targetContextId)).toBe("직접 입력한 메모\n");
    expect(c.controller.getSnapshot().error).toBe("No editable field");
  });

  it("releases a late field capture after cancellation without ever locking it", async () => {
    const c = await setup();
    const capture = deferred<CapturedField>();
    c.actions.captureRefinementTarget.mockReturnValueOnce(capture.promise);
    const stopped = c.startFinishing();
    c.controller.cancelPendingAction();
    capture.resolve(first);
    await c.closeServer();
    await stopped;
    expect(c.actions.beginRefinement).not.toHaveBeenCalled();
    expect(c.actions.releaseTarget).toHaveBeenCalledExactlyOnceWith(first.targetContextId);
    expect(c.auth.postEdit).not.toHaveBeenCalled();
  });

  it("waits for the native final insertion acknowledgement before locking or reading the field", async () => {
    const c = await setup();
    const delivered = deferred<void>();
    c.actions.insertText.mockImplementationOnce(async (text) => {
      await delivered.promise;
      c.fields.set(first.targetContextId, c.fields.get(first.targetContextId)! + text);
    });
    final(c.socket, "마지막으로 도착한 전사");
    await flushPromises();
    const stopped = c.startFinishing();
    await c.closeServer();
    expect(c.actions.captureRefinementTarget).toHaveBeenCalledTimes(1);
    expect(c.actions.beginRefinement).not.toHaveBeenCalled();
    expect(c.auth.postEdit).not.toHaveBeenCalled();
    delivered.resolve();
    await c.refining.promise;
    expect(c.auth.postEdit.mock.calls[0]?.[0]).toBe("직접 입력한 메모\n마지막으로 도착한 전사 ");
    c.refinement.resolve("직접 입력한 메모\n마지막으로 도착한 전사.");
    await stopped;
    expect(c.state.locked).toBeNull();
  });

  it("releases an empty field without calling the model", async () => {
    const c = await setup();
    c.fields.set(first.targetContextId, "  \n");
    const stopped = c.startFinishing();
    await c.closeServer();
    await stopped;
    expect(c.auth.postEdit).not.toHaveBeenCalled();
    expect(c.actions.applyRefinement).not.toHaveBeenCalled();
    expect(c.actions.releaseTarget).toHaveBeenCalledExactlyOnceWith(first.targetContextId);
    expect(c.state.locked).toBeNull();
  });

  it("ignores cancellation events for a different field", async () => {
    const c = await setup();
    const stopped = c.startFinishing();
    await c.closeServer();
    const signal = await c.refining.promise;
    c.actions.emit("refinement-cancelled", second.targetContextId);
    expect(signal.aborted).toBe(false);
    c.refinement.resolve("보정한 메모");
    await stopped;
    expect(c.fields.get(first.targetContextId)).toBe("보정한 메모");
  });
});
