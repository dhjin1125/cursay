import { describe, expect, it } from "vitest";
import { CaptureStateMachine } from "../shared/capture-state";

describe("CaptureStateMachine", () => {
  it("uses one session for Fn tap-to-lock and the next tap stops it", () => {
    const machine = new CaptureStateMachine();
    const started = machine.handlePushToTalk({
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "target-1",
      timestampMs: 1_000,
    });
    expect(started.state).toMatchObject({
      sessionId: 1,
      phase: "starting",
      mode: "fn-hold",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "target-1",
      targetBinding: "foreground",
    });

    machine.acceptLifecycle({ sessionId: 1, status: "active" });
    const locked = machine.handlePushToTalk({
      state: "up",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "target-1",
      timestampMs: 1_100,
    });
    expect(locked.state).toMatchObject({ phase: "active", mode: "fn-continuous" });

    machine.handlePushToTalk({
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "target-1",
      timestampMs: 2_000,
    });
    const stopping = machine.handlePushToTalk({
      state: "up",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "target-1",
      timestampMs: 2_080,
    });
    expect(stopping.state).toMatchObject({
      sessionId: 1,
      phase: "stopping",
      targetContextId: "target-1",
    });

    const stopped = machine.acceptLifecycle({ sessionId: 1, status: "stopped" });
    expect(stopped.state).toMatchObject({
      phase: "idle",
      mode: null,
      targetBundleId: null,
      targetContextId: null,
    });
  });

  it("tracks target metadata, background pinning, and invalidation in the central state", () => {
    const machine = new CaptureStateMachine();
    const context = "123e4567-e89b-42d3-a456-426614174000";
    const started = machine.handlePushToTalk({
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: context,
      targetDisplayName: "Codex",
      targetBundlePath: "/Applications/Codex.app",
      targetBinding: "foreground",
      timestampMs: 1_000,
    });
    expect(started.state).toMatchObject({
      targetDisplayName: "Codex",
      targetBinding: "foreground",
      targetBindingReason: null,
      targetIconDataUrl: null,
    });

    const background = machine.acceptTargetBinding({
      targetContextId: context,
      binding: "background",
      reason: null,
      timestampMs: 1_100,
    });
    expect(background.state.targetBinding).toBe("background");

    const withIcon = machine.setTargetIcon(context, "data:image/png;base64,aWNvbg==");
    expect(withIcon.state.targetIconDataUrl).toBe("data:image/png;base64,aWNvbg==");
    const staleIcon = machine.setTargetIcon(
      "223e4567-e89b-42d3-a456-426614174000",
      "data:image/png;base64,c3RhbGU=",
    );
    expect(staleIcon.changed).toBe(false);
    expect(staleIcon.state.targetIconDataUrl).toBe("data:image/png;base64,aWNvbg==");

    const invalid = machine.acceptTargetBinding({
      targetContextId: context,
      binding: "invalid",
      reason: "input-unavailable",
      timestampMs: 1_200,
    });
    expect(invalid.state).toMatchObject({
      targetBinding: "invalid",
      targetBindingReason: "input-unavailable",
    });

    const stale = machine.acceptTargetBinding({
      targetContextId: "223e4567-e89b-42d3-a456-426614174000",
      binding: "foreground",
      reason: null,
      timestampMs: 1_300,
    });
    expect(stale.changed).toBe(false);
    expect(stale.state.targetBinding).toBe("invalid");
  });

  it("keeps capture active while a pinned field is temporarily rebinding", () => {
    const machine = new CaptureStateMachine();
    const context = "123e4567-e89b-42d3-a456-426614174000";
    machine.handlePushToTalk({
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: context,
      targetBinding: "foreground",
      timestampMs: 1_000,
    });
    machine.acceptLifecycle({ sessionId: 1, status: "active" });

    const waiting = machine.acceptTargetBinding({
      targetContextId: context,
      binding: "rebinding",
      reason: null,
      timestampMs: 1_100,
    });
    expect(waiting.state).toMatchObject({
      phase: "active",
      targetBinding: "rebinding",
      targetBindingReason: null,
      error: null,
    });

    const recovered = machine.acceptTargetBinding({
      targetContextId: context,
      binding: "foreground",
      reason: null,
      timestampMs: 1_200,
    });
    expect(recovered.state).toMatchObject({
      phase: "active",
      targetBinding: "foreground",
      error: null,
    });
  });

  it("stops a held Fn session on release even while start is still completing", () => {
    const machine = new CaptureStateMachine();
    machine.handlePushToTalk({
      state: "down",
      targetMode: "live",
      targetBundleId: null,
      targetContextId: null,
      timestampMs: 1_000,
    });
    const stopping = machine.handlePushToTalk({
      state: "up",
      targetMode: "live",
      targetBundleId: null,
      targetContextId: null,
      timestampMs: 1_800,
    });
    expect(stopping.state.phase).toBe("stopping");

    const staleActive = machine.acceptLifecycle({ sessionId: 1, status: "active" });
    expect(staleActive.changed).toBe(false);
    expect(staleActive.state.phase).toBe("stopping");
  });

  it("resets Fn ownership when manual stop is requested", () => {
    const machine = new CaptureStateMachine();
    machine.handlePushToTalk({ state: "down", targetMode: "live", targetBundleId: null, targetContextId: null, timestampMs: 1_000 });
    machine.handlePushToTalk({ state: "up", targetMode: "live", targetBundleId: null, targetContextId: null, timestampMs: 1_100 });
    const stopping = machine.request("stop");
    expect(stopping.state.phase).toBe("stopping");
    machine.acceptLifecycle({ sessionId: 1, status: "stopped" });

    const strayRelease = machine.handlePushToTalk({
      state: "up",
      targetMode: "live",
      targetBundleId: null,
      targetContextId: null,
      timestampMs: 2_000,
    });
    expect(strayRelease.changed).toBe(false);
    expect(strayRelease.state.phase).toBe("idle");
  });

  it("ignores lifecycle completions from an older session", () => {
    const machine = new CaptureStateMachine();
    machine.request("start");
    machine.acceptLifecycle({ sessionId: 1, status: "error", error: "first failed" });
    machine.acceptLifecycle({ sessionId: 1, status: "stopped" });
    const second = machine.request("start");
    expect(second.state).toMatchObject({ sessionId: 2, phase: "starting", error: null });

    const staleStop = machine.acceptLifecycle({ sessionId: 1, status: "stopped" });
    expect(staleStop.changed).toBe(false);
    expect(staleStop.state).toMatchObject({ sessionId: 2, phase: "starting" });
  });

  it("keeps a fatal error visible after local resources finish stopping", () => {
    const machine = new CaptureStateMachine();
    machine.request("start");
    machine.acceptLifecycle({ sessionId: 1, status: "active" });
    const recovering = machine.fail("transport failed");
    expect(recovering.state).toMatchObject({
      phase: "stopping",
      mode: "manual",
      targetMode: "configured",
      error: "transport failed",
    });
    const refusedRestart = machine.request("start");
    expect(refusedRestart.changed).toBe(false);
    expect(refusedRestart.state.sessionId).toBe(1);

    const cleaned = machine.acceptLifecycle({ sessionId: 1, status: "stopped" });
    expect(cleaned.state).toMatchObject({
      phase: "error",
      mode: null,
      targetBundleId: null,
      targetBinding: "none",
      error: "transport failed",
    });
  });

  it("keeps invalid target presentation visible after capture resources stop", () => {
    const machine = new CaptureStateMachine();
    const context = "123e4567-e89b-42d3-a456-426614174000";
    machine.handlePushToTalk({
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: context,
      targetDisplayName: "Codex",
      targetBinding: "foreground",
      timestampMs: 1_000,
    });
    machine.setTargetIcon(context, "data:image/png;base64,aWNvbg==");
    machine.acceptLifecycle({ sessionId: 1, status: "active" });
    machine.acceptTargetBinding({
      targetContextId: context,
      binding: "invalid",
      reason: "process-terminated",
      timestampMs: 1_100,
    });
    machine.fail("Codex 앱이 종료되어 연결이 끊겼습니다.");
    const stopped = machine.acceptLifecycle({ sessionId: 1, status: "stopped" });

    expect(stopped.state).toMatchObject({
      phase: "error",
      targetBundleId: "com.openai.codex",
      targetContextId: null,
      targetDisplayName: "Codex",
      targetIconDataUrl: "data:image/png;base64,aWNvbg==",
      targetBinding: "invalid",
      targetBindingReason: "process-terminated",
    });
  });
});
