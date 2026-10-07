import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getTargetIconCacheKey,
  getTargetIconCandidates,
} from "../electron/services/TargetIconResolver.js";

describe("target icon resolver", () => {
  it("prefers the nested Codex artwork for the Codex runtime", () => {
    const bundlePath = "/Applications/ChatGPT.app";

    expect(getTargetIconCandidates(bundlePath, "com.openai.codex")).toEqual([
      path.join(bundlePath, "Contents", "Resources", "icon-codex-dark-color.png"),
      path.join(bundlePath, "Contents", "Resources", "icon-codex-light.png"),
    ]);
  });

  it("falls back to the owning app icon for ordinary applications", () => {
    expect(getTargetIconCandidates("/Applications/Notes.app", "com.apple.Notes")).toEqual([]);
  });

  it("keeps icons from nested runtimes separate in the cache", () => {
    const bundlePath = "/Applications/ChatGPT.app";

    expect(getTargetIconCacheKey(bundlePath, "com.openai.codex"))
      .not.toBe(getTargetIconCacheKey(bundlePath, "com.openai.chat"));
  });
});
