import { describe, expect, it } from "vitest";
import {
  parsePushToTalkBridgeEvent,
  parseRefinementCancellation,
  parseTargetBindingBridgeEvent,
} from "../electron/services/ActionBridge";

describe("push-to-talk bridge event", () => {
  it("accepts the mode-only event emitted by the native Fn monitor", () => {
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "down",
      targetMode: "live",
      timestampMs: 10_000,
    }, 10_000)).toEqual({
      state: "down",
      targetMode: "live",
      targetBundleId: null,
      targetContextId: null,
      targetDisplayName: null,
      targetBundlePath: null,
      targetBinding: "none",
      timestampMs: 10_000,
    });
  });

  it("accepts a fresh function-key event and preserves the captured target", () => {
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      targetDisplayName: "Codex",
      targetBundlePath: "/Applications/Codex.app",
      targetBinding: "foreground",
      timestampMs: 10_000,
    }, 12_000)).toEqual({
      state: "down",
      targetMode: "pinned",
      targetBundleId: "com.openai.codex",
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      targetDisplayName: "Codex",
      targetBundlePath: "/Applications/Codex.app",
      targetBinding: "foreground",
      timestampMs: 10_000,
    });
  });

  it("rejects stale or malformed helper events", () => {
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "down",
      targetMode: "live",
      targetContextId: null,
      timestampMs: 1_000,
    }, 7_001)).toBeNull();
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "pressed",
      targetMode: "live",
      targetContextId: null,
      timestampMs: 10_000,
    }, 10_000)).toBeNull();
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "down",
      targetMode: "pinned",
      targetContextId: "not-a-context",
      timestampMs: 10_000,
    }, 10_000)).toBeNull();
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "down",
      targetMode: "configured",
      targetContextId: null,
      timestampMs: 10_000,
    }, 10_000)).toBeNull();
    expect(parsePushToTalkBridgeEvent({
      type: "functionKey",
      state: "down",
      targetMode: "pinned",
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      targetBundlePath: "../../unexpected.app",
      timestampMs: 10_000,
    }, 10_000)).toBeNull();
  });
});

describe("target-binding bridge event", () => {
  it("accepts a fresh state transition for the captured context", () => {
    expect(parseTargetBindingBridgeEvent({
      type: "targetBinding",
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      binding: "background",
      reason: null,
      timestampMs: 10_000,
    }, 10_100)).toEqual({
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      binding: "background",
      reason: null,
      timestampMs: 10_000,
    });
  });

  it("requires a reason for invalid and rejects stale contexts", () => {
    expect(parseTargetBindingBridgeEvent({
      type: "targetBinding",
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      binding: "invalid",
      timestampMs: 10_000,
    }, 10_000)).toBeNull();
    expect(parseTargetBindingBridgeEvent({
      type: "targetBinding",
      targetContextId: "123e4567-e89b-42d3-a456-426614174000",
      binding: "invalid",
      reason: "process-terminated",
      timestampMs: 1_000,
    }, 7_000)).toBeNull();
  });
});


describe("field refinement cancellation event", () => {
  const event = { type: "refinementCancelled", targetContextId: "123e4567-e89b-42d3-a456-426614174000", timestampMs: 10_000 };
  it("requires a fresh, valid field context", () => {
    expect(parseRefinementCancellation(event, 10_001)).toBe(event.targetContextId);
    expect(parseRefinementCancellation(event, 15_001)).toBeNull();
    expect(parseRefinementCancellation({ ...event, targetContextId: "any-field" }, 10_001)).toBeNull();
    expect(parseRefinementCancellation({ ...event, timestampMs: NaN }, 10_001)).toBeNull();
  });
});
