import { describe, expect, it, vi } from "vitest";
import { CaptureExecutor } from "../src/audio/CaptureExecutor";
import { CaptureStateMachine } from "../shared/capture-state";

describe("Capture event executor", () => {
  it("starts synchronously from the event and reports active before connection completion", () => {
    let recording!: () => void;
    const microphone = {
      start: vi.fn((_request, onRecording) => {
        recording = onRecording;
        return new Promise<void>(() => undefined);
      }),
      stop: vi.fn(async () => undefined),
    };
    const report = vi.fn();
    const executor = new CaptureExecutor(microphone, report);
    const machine = new CaptureStateMachine();
    const state = machine.request("start").state;
    executor.accept(state);
    expect(microphone.start).toHaveBeenCalledOnce();
    recording();
    expect(report).toHaveBeenLastCalledWith({ sessionId: state.sessionId, status: "active" });
    executor.accept({ ...state, revision: state.revision + 1, mode: "fn-continuous" });
    executor.accept(state);
    expect(microphone.start).toHaveBeenCalledOnce();
  });

  it("stops during startup and ignores stale completion and errors", async () => {
    let recording!: () => void;
    let fail!: (error: Error) => void;
    const microphone = {
      start: vi.fn((_request, onRecording) => {
        recording = onRecording;
        return new Promise<void>((_resolve, reject) => { fail = reject; });
      }),
      stop: vi.fn(async () => undefined),
    };
    const report = vi.fn();
    const executor = new CaptureExecutor(microphone, report);
    const machine = new CaptureStateMachine();
    executor.accept(machine.request("start").state);
    const stopped = machine.request("stop").state;
    executor.accept(stopped);
    expect(microphone.stop).toHaveBeenCalledOnce();
    recording();
    fail(new Error("Late connection failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(report.mock.calls.map(([event]) => event.status)).toEqual(["starting", "stopping", "stopped"]);
  });
});
