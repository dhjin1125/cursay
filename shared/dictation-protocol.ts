import { z } from "zod";

const baseEventSchema = z
  .object({
    type: z.string(),
    sequence_no: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const transcriptEventSchema = baseEventSchema.extend({
  utterance_id: z.string().min(1),
  revision: z.number().int().nonnegative().default(0),
  text: z.string(),
});

const failureEventSchema = baseEventSchema.extend({
  utterance_id: z.string().optional(),
  error: z.unknown().optional(),
});

const sessionEventSchema = baseEventSchema.extend({
  session: z.object({
    session_id: z.string(),
    status: z.enum(["active", "closed"]),
    config: z.object({
      provider_mode: z.enum(["buffered", "streaming_sse"]),
      transcript_delivery_mode: z.enum(["final_only", "segment", "delta"]),
    }).passthrough(),
  }).passthrough(),
});

export type TranscriptDeliveryMode = "final_only" | "segment" | "delta";

export type DictationEvent =
  | (z.infer<typeof sessionEventSchema> & {
      type: "session.started" | "session.updated";
    })
  | (z.infer<typeof baseEventSchema> & {
      type: "speech.started" | "speech.stopped";
      utterance_id?: string;
    })
  | (z.infer<typeof transcriptEventSchema> & {
      type: "transcript.delta" | "transcript.segment" | "transcript.final";
    })
  | (z.infer<typeof failureEventSchema> & {
      type: "transcript.failed" | "session.error";
    })
  | (z.infer<typeof baseEventSchema> & { type: string });

export interface SessionStartFrame {
  type: "session.start";
  config: {
    input_audio_format: "pcm16";
    sample_rate_hz: number;
    num_channels: 1;
    max_buffer_size_bytes: number;
    max_utterance_duration_ms: number;
    session_ttl_ms: number;
    provider_mode: "streaming_sse";
    transcript_delivery_mode: "segment";
    vad: {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
    };
  };
}

export function createSessionStartFrame(
  sampleRate: number,
  silenceDurationMs: number,
): SessionStartFrame {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error("Unsupported microphone sample rate.");
  }

  return {
    type: "session.start",
    config: {
      input_audio_format: "pcm16",
      sample_rate_hz: Math.round(sampleRate),
      num_channels: 1,
      max_buffer_size_bytes: 4_194_304,
      max_utterance_duration_ms: 30_000,
      session_ttl_ms: 300_000,
      provider_mode: "streaming_sse",
      transcript_delivery_mode: "segment",
      vad: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: Math.max(300, Math.min(3_000, Math.round(silenceDurationMs))),
      },
    },
  };
}

export function parseDictationEvent(value: unknown): DictationEvent {
  const base = baseEventSchema.parse(value);

  if (base.type === "session.started" || base.type === "session.updated") {
    return sessionEventSchema.parse(value) as DictationEvent;
  }

  if (
    base.type === "transcript.delta" ||
    base.type === "transcript.segment" ||
    base.type === "transcript.final"
  ) {
    return transcriptEventSchema.parse(value) as DictationEvent;
  }

  if (base.type === "transcript.failed" || base.type === "session.error") {
    return failureEventSchema.parse(value) as DictationEvent;
  }

  return base as DictationEvent;
}

export function encodeAudioFrame(bytes: Uint8Array): string {
  return JSON.stringify({ type: "audio.append", audio: Buffer.from(bytes).toString("base64") });
}

const secretPattern = /(bearer|token|authorization|protocol)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        secretPattern.test(key) ? "[REDACTED]" : redactSecrets(item),
      ]),
    );
  }

  if (typeof value === "string" && value.includes("openai-bearer.")) {
    return "[REDACTED]";
  }

  return value;
}
