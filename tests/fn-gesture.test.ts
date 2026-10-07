import { describe, expect, it } from "vitest";
import {
  createFnGestureState,
  transitionFnGesture,
} from "../shared/fn-gesture";

describe("Fn hybrid gesture", () => {
  it("locks continuous input after a short tap and stops on the next tap", () => {
    const down = transitionFnGesture(createFnGestureState(), "down", 1_000);
    expect(down.action).toBe("start");
    const locked = transitionFnGesture(down.state, "up", 1_120);
    expect(locked).toMatchObject({ action: "lock-continuous", state: { mode: "continuous" } });
    const stopDown = transitionFnGesture(locked.state, "down", 2_000);
    expect(stopDown).toMatchObject({ action: "stop", state: { mode: "idle" } });
    const stopped = transitionFnGesture(stopDown.state, "up", 2_080);
    expect(stopped).toMatchObject({ action: "none", state: { mode: "idle" } });
  });

  it("uses release as stop after a hold", () => {
    const down = transitionFnGesture(createFnGestureState(), "down", 1_000);
    const released = transitionFnGesture(down.state, "up", 1_800);
    expect(released).toMatchObject({
      action: "stop",
      heldForMs: 800,
      state: { mode: "idle" },
    });
  });
});
