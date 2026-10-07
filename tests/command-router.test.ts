import { describe, expect, it } from "vitest";
import { CommandRouter, normalizeCommandText } from "../shared/command-router";
import { DEFAULT_COMMANDS } from "../shared/contracts";

describe("CommandRouter", () => {
  it("normalizes spacing and punctuation for exact phrases", () => {
    expect(normalizeCommandText(" 오케이,  OpenAI! 전송 ")).toBe("오케이 openai 전송");
    const router = new CommandRouter();
    expect(router.route("오케이, 오픈AI 전송!", DEFAULT_COMMANDS, 2_000)?.command.id).toBe(
      "codex-send",
    );
  });

  it("does not fire when a trigger is embedded in a longer sentence", () => {
    const router = new CommandRouter();
    expect(router.route("누룽지 먹고 싶다", DEFAULT_COMMANDS, 2_000)).toBeNull();
  });

  it("enforces cooldown", () => {
    const router = new CommandRouter();
    expect(router.route("누룽지", DEFAULT_COMMANDS, 2_000)).not.toBeNull();
    expect(router.route("누룽지", DEFAULT_COMMANDS, 2_500)).toBeNull();
    expect(router.route("누룽지", DEFAULT_COMMANDS, 3_001)).not.toBeNull();
  });

  it("never fires a disabled command", () => {
    const router = new CommandRouter();
    expect(
      router.route("누룽지", [{ ...DEFAULT_COMMANDS[0], enabled: false }], 2_000),
    ).toBeNull();
  });
});
