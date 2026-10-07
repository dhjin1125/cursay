import type {
  CaptureLifecycleEvent,
  CaptureMode,
  CaptureRequest,
  CaptureState,
  PushToTalkEvent,
  TargetBindingEvent,
} from "./contracts.js";
import {
  createFnGestureState,
  transitionFnGesture,
  type FnGestureState,
} from "./fn-gesture.js";

export interface CaptureTransition {
  state: CaptureState;
  changed: boolean;
}

export function createInitialCaptureState(): CaptureState {
  return {
    sessionId: 0,
    revision: 0,
    phase: "idle",
    mode: null,
    targetMode: null,
    targetBundleId: null,
    targetContextId: null,
    targetDisplayName: null,
    targetIconDataUrl: null,
    targetBinding: "none",
    targetBindingReason: null,
    error: null,
  };
}

function copyState(state: CaptureState): CaptureState {
  return { ...state };
}

export class CaptureStateMachine {
  private state = createInitialCaptureState();
  private fnGesture: FnGestureState = createFnGestureState();

  getState(): CaptureState {
    return copyState(this.state);
  }

  handlePushToTalk(event: PushToTalkEvent): CaptureTransition {
    const gesture = transitionFnGesture(
      this.fnGesture,
      event.state,
      event.timestampMs,
    );
    this.fnGesture = gesture.state;

    if (gesture.action === "start") {
      if (!this.canStart()) {
        this.fnGesture = createFnGestureState();
        return this.unchanged();
      }
      return this.begin("fn-hold", event);
    }

    if (
      gesture.action === "lock-continuous" &&
      this.state.mode === "fn-hold" &&
      (this.state.phase === "starting" || this.state.phase === "active")
    ) {
      return this.commit({ mode: "fn-continuous" });
    }

    if (
      gesture.action === "stop" &&
      (this.state.mode === "fn-hold" || this.state.mode === "fn-continuous")
    ) {
      return this.stop();
    }

    return this.unchanged();
  }

  request(action: CaptureRequest): CaptureTransition {
    if (action === "start") {
      if (!this.canStart()) return this.unchanged();
      this.fnGesture = createFnGestureState();
      return this.begin("manual", null);
    }

    this.fnGesture = createFnGestureState();
    if (this.state.phase === "error") {
      return this.commit({
        phase: "idle",
        mode: null,
        targetMode: null,
        targetBundleId: null,
        targetContextId: null,
        targetDisplayName: null,
        targetIconDataUrl: null,
        targetBinding: "none",
        targetBindingReason: null,
        error: null,
      });
    }
    return this.stop();
  }

  acceptLifecycle(event: CaptureLifecycleEvent): CaptureTransition {
    if (event.sessionId !== this.state.sessionId || event.sessionId === 0) {
      return this.unchanged();
    }

    switch (event.status) {
      case "starting":
        return this.unchanged();
      case "active":
        return this.state.phase === "starting"
          ? this.commit({ phase: "active", error: null })
          : this.unchanged();
      case "stopping":
        return this.state.phase === "starting" || this.state.phase === "active"
          ? this.stop()
          : this.unchanged();
      case "stopped":
        this.fnGesture = createFnGestureState();
        if (this.state.error) {
          return this.commit({
            phase: "error",
            mode: null,
            targetMode: null,
            targetContextId: null,
          });
        }
        return this.commit({
          phase: "idle",
          mode: null,
          targetMode: null,
          targetBundleId: null,
          targetContextId: null,
          targetDisplayName: null,
          targetIconDataUrl: null,
          targetBinding: "none",
          targetBindingReason: null,
          error: null,
        });
      case "error":
        this.fnGesture = createFnGestureState();
        if (this.state.phase === "starting" || this.state.phase === "active") {
          return this.commit({
            phase: "stopping",
            error: event.error?.trim() || "Voice capture failed.",
          });
        }
        if (this.state.phase === "stopping") {
          return this.commit({
            phase: "error",
            mode: null,
            targetMode: null,
            targetBundleId: null,
            targetContextId: null,
            error: event.error?.trim() || this.state.error || "Voice capture failed.",
          });
        }
        return this.unchanged();
    }
  }

  fail(error: string): CaptureTransition {
    if (this.state.phase === "idle" || this.state.phase === "error") {
      return this.unchanged();
    }
    this.fnGesture = createFnGestureState();
    return this.commit({
      phase: "stopping",
      error: error.trim() || "Voice capture failed.",
    });
  }

  acceptTargetBinding(event: TargetBindingEvent): CaptureTransition {
    if (
      !this.state.targetContextId ||
      event.targetContextId !== this.state.targetContextId ||
      (this.state.phase !== "starting" && this.state.phase !== "active")
    ) {
      return this.unchanged();
    }
    return this.commit({
      targetBinding: event.binding,
      targetBindingReason: event.binding === "invalid" ? event.reason : null,
    });
  }

  setTargetIcon(targetContextId: string, dataUrl: string): CaptureTransition {
    if (
      targetContextId !== this.state.targetContextId ||
      !dataUrl.startsWith("data:image/png;base64,") ||
      dataUrl.length > 200_000
    ) {
      return this.unchanged();
    }
    return this.commit({ targetIconDataUrl: dataUrl });
  }

  private canStart(): boolean {
    return this.state.phase === "idle" || this.state.phase === "error";
  }

  private begin(
    mode: Exclude<CaptureMode, null>,
    event: PushToTalkEvent | null,
  ): CaptureTransition {
    const targetBundleId = event?.targetBundleId ?? null;
    const targetContextId = event?.targetContextId ?? null;
    this.state = {
      sessionId: this.state.sessionId + 1,
      revision: this.state.revision + 1,
      phase: "starting",
      mode,
      targetMode: event?.targetMode ?? "configured",
      targetBundleId,
      targetContextId,
      targetDisplayName: targetContextId
        ? event?.targetDisplayName?.trim().slice(0, 120) || targetBundleId
        : null,
      targetIconDataUrl: null,
      targetBinding: targetContextId
        ? event?.targetBinding === "background" ? "background" : "foreground"
        : "none",
      targetBindingReason: null,
      error: null,
    };
    return { state: this.getState(), changed: true };
  }

  private stop(): CaptureTransition {
    if (this.state.phase !== "starting" && this.state.phase !== "active") {
      return this.unchanged();
    }
    return this.commit({ phase: "stopping" });
  }

  private commit(patch: Partial<Omit<CaptureState, "sessionId" | "revision">>): CaptureTransition {
    const next = { ...this.state, ...patch };
    const changed =
      next.phase !== this.state.phase ||
      next.mode !== this.state.mode ||
      next.targetMode !== this.state.targetMode ||
      next.targetBundleId !== this.state.targetBundleId ||
      next.targetContextId !== this.state.targetContextId ||
      next.targetDisplayName !== this.state.targetDisplayName ||
      next.targetIconDataUrl !== this.state.targetIconDataUrl ||
      next.targetBinding !== this.state.targetBinding ||
      next.targetBindingReason !== this.state.targetBindingReason ||
      next.error !== this.state.error;
    if (!changed) return this.unchanged();
    this.state = { ...next, revision: this.state.revision + 1 };
    return { state: this.getState(), changed: true };
  }

  private unchanged(): CaptureTransition {
    return { state: this.getState(), changed: false };
  }
}
