import { describe, expect, it } from "vitest";
import {
  createSessionStartFrame,
  parseDictationEvent,
  redactSecrets,
} from "../shared/dictation-protocol";

describe("dictation protocol", () => {
  it("creates the bounded segment-delivery server VAD session", () => {
    const frame = createSessionStartFrame(48_000, 120);
    expect(frame).toEqual({
      type: "session.start",
      config: expect.objectContaining({
        input_audio_format: "pcm16",
        sample_rate_hz: 48_000,
        num_channels: 1,
        transcript_delivery_mode: "segment",
        vad: expect.objectContaining({ silence_duration_ms: 300 }),
      }),
    });
  });

  it("rejects an invalid transcript payload", () => {
    expect(() =>
      parseDictationEvent({
        type: "transcript.final",
        sequence_no: 9,
        utterance_id: "u-1",
        revision: 1,
      }),
    ).toThrow();
  });

  it("redacts auth material recursively", () => {
    const result = redactSecrets({
      token: "secret",
      nested: { authorization: "Bearer secret", safe: "session.started" },
      protocols: ["chatgpt-dictation", "openai-bearer.secret"],
    });
    expect(result).toEqual({
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "session.started" },
      protocols: "[REDACTED]",
    });
  });
});
