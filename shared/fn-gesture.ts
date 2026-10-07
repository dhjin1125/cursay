export const FN_TAP_MAX_MS = 350;

export type FnGestureMode =
  | "idle"
  | "pressed"
  | "continuous"
  | "continuous-pressed";

export interface FnGestureState {
  mode: FnGestureMode;
  downAt: number | null;
}

export type FnGestureAction = "none" | "start" | "lock-continuous" | "stop";

export interface FnGestureTransition {
  state: FnGestureState;
  action: FnGestureAction;
  heldForMs: number | null;
}

export function createFnGestureState(): FnGestureState {
  return { mode: "idle", downAt: null };
}

export function transitionFnGesture(
  current: FnGestureState,
  signal: "down" | "up",
  timestampMs: number,
): FnGestureTransition {
  if (signal === "down") {
    if (current.mode === "idle") {
      return {
        state: { mode: "pressed", downAt: timestampMs },
        action: "start",
        heldForMs: null,
      };
    }
    if (current.mode === "continuous") {
      return {
        state: createFnGestureState(),
        action: "stop",
        heldForMs: null,
      };
    }
    return { state: current, action: "none", heldForMs: null };
  }

  if (current.mode === "pressed" && current.downAt !== null) {
    const heldForMs = Math.max(0, timestampMs - current.downAt);
    if (heldForMs <= FN_TAP_MAX_MS) {
      return {
        state: { mode: "continuous", downAt: null },
        action: "lock-continuous",
        heldForMs,
      };
    }
    return {
      state: createFnGestureState(),
      action: "stop",
      heldForMs,
    };
  }

  if (current.mode === "continuous-pressed") {
    return {
      state: createFnGestureState(),
      action: "stop",
      heldForMs: current.downAt === null
        ? null
        : Math.max(0, timestampMs - current.downAt),
    };
  }

  return { state: current, action: "none", heldForMs: null };
}

export function isFnContinuous(state: FnGestureState): boolean {
  return state.mode === "continuous" || state.mode === "continuous-pressed";
}

export function isFnPressed(state: FnGestureState): boolean {
  return state.mode === "pressed" || state.mode === "continuous-pressed";
}
