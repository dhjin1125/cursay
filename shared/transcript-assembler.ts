import type { DictationEvent } from "./dictation-protocol.js";

export interface TranscriptUpdate {
  kind: "segment" | "final";
  utteranceId: string;
  revision: number;
  sequenceNo: number | null;
  text: string;
}

interface UtteranceState {
  revision: number;
  text: string;
  lastSegmentText: string;
  final: boolean;
}

export class TranscriptAssembler {
  private readonly utterances = new Map<string, UtteranceState>();
  private readonly seenSequences = new Set<number>();
  private sequenceOrder: number[] = [];

  ingest(event: DictationEvent): TranscriptUpdate | null {
    if (
      (event.type !== "transcript.segment" && event.type !== "transcript.final") ||
      typeof event.utterance_id !== "string" ||
      typeof event.revision !== "number" ||
      typeof event.text !== "string"
    ) {
      return null;
    }

    const utteranceId = event.utterance_id;
    const revision = event.revision;
    const eventText = event.text;

    const sequenceNo = event.sequence_no ?? null;
    if (sequenceNo !== null && this.seenSequences.has(sequenceNo)) {
      return null;
    }

    if (sequenceNo !== null) {
      this.seenSequences.add(sequenceNo);
      this.sequenceOrder.push(sequenceNo);
      if (this.sequenceOrder.length > 2_048) {
        const expired = this.sequenceOrder.shift();
        if (expired !== undefined) this.seenSequences.delete(expired);
      }
    }

    const current = this.utterances.get(utteranceId);
    if (current?.final || (current && revision < current.revision)) {
      return null;
    }

    const clean = eventText.trim();
    if (!clean) return null;

    if (event.type === "transcript.segment") {
      if (current && current.revision === revision && current.lastSegmentText === clean) {
        return null;
      }
      const text = mergeSegmentText(current?.text ?? "", clean);
      if (current && text === current.text) return null;
      this.utterances.set(utteranceId, {
        revision,
        text,
        lastSegmentText: clean,
        final: false,
      });
      return {
        kind: "segment",
        utteranceId,
        revision,
        sequenceNo,
        text,
      };
    }

    const text = clean;
    this.utterances.set(utteranceId, {
      revision,
      text,
      lastSegmentText: current?.lastSegmentText ?? "",
      final: true,
    });

    return {
      kind: "final",
      utteranceId,
      revision,
      sequenceNo,
      text,
    };
  }

  reset(): void {
    this.utterances.clear();
    this.seenSequences.clear();
    this.sequenceOrder = [];
  }
}

function mergeSegmentText(previous: string, incoming: string): string {
  if (!previous) return incoming;
  if (incoming === previous || previous.endsWith(incoming)) return previous;
  if (incoming.startsWith(previous)) return incoming;
  const shorterLength = Math.min(previous.length, incoming.length);
  let commonPrefixLength = 0;
  while (
    commonPrefixLength < shorterLength &&
    previous[commonPrefixLength] === incoming[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }
  if (shorterLength >= 4 && commonPrefixLength / shorterLength >= 0.6) {
    return incoming;
  }
  return appendUtterance(previous, incoming);
}

export function appendUtterance(previous: string, next: string): string {
  const clean = next.trim();
  if (!clean) return previous;
  if (!previous.trim()) return clean;

  const noLeadingSpace = /^[,.;:!?\)\]}…。，、！？]/u.test(clean);
  const noTrailingSpace = /[\s\n([{]$/u.test(previous);
  return `${previous}${noLeadingSpace || noTrailingSpace ? "" : " "}${clean}`;
}

export function appendOnlyDifference(previous: string, next: string): string | null {
  if (!previous) return next;
  if (previous === next) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);
  return null;
}
