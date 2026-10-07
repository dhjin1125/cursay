import { describe, expect, it } from "vitest";
import {
  TranscriptAssembler,
  appendOnlyDifference,
  appendUtterance,
} from "../shared/transcript-assembler";

describe("TranscriptAssembler", () => {
  it("commits one final revision per utterance", () => {
    const assembler = new TranscriptAssembler();
    const event = {
      type: "transcript.final",
      sequence_no: 7,
      utterance_id: "utterance-1",
      revision: 2,
      text: "  테스트 문장  ",
    } as const;
    expect(assembler.ingest(event)).toEqual({
      kind: "final",
      utteranceId: "utterance-1",
      revision: 2,
      sequenceNo: 7,
      text: "테스트 문장",
    });
    expect(assembler.ingest(event)).toBeNull();
    expect(
      assembler.ingest({ ...event, sequence_no: 8, revision: 1 }),
    ).toBeNull();
  });

  it("assembles stable segment events and finalizes without duplicating text", () => {
    const assembler = new TranscriptAssembler();
    expect(
      assembler.ingest({
        type: "transcript.segment",
        sequence_no: 1,
        utterance_id: "utterance-1",
        revision: 1,
        text: "실시간",
      }),
    ).toEqual({
      kind: "segment",
      utteranceId: "utterance-1",
      revision: 1,
      sequenceNo: 1,
      text: "실시간",
    });
    expect(
      assembler.ingest({
        type: "transcript.segment",
        sequence_no: 2,
        utterance_id: "utterance-1",
        revision: 2,
        text: "전사",
      }),
    ).toEqual(expect.objectContaining({ kind: "segment", text: "실시간 전사" }));
    expect(
      assembler.ingest({
        type: "transcript.final",
        sequence_no: 3,
        utterance_id: "utterance-1",
        revision: 2,
        text: "실시간 전사",
      }),
    ).toEqual(expect.objectContaining({ kind: "final", text: "실시간 전사" }));
  });

  it("calculates only the appendable suffix", () => {
    expect(appendOnlyDifference("실시간", "실시간 전사")).toBe(" 전사");
    expect(appendOnlyDifference("실시간 전사", "실시간 전사")).toBe("");
    expect(appendOnlyDifference("잘못된", "수정된 결과")).toBeNull();
  });

  it("replaces a likely segment revision instead of duplicating it", () => {
    const assembler = new TranscriptAssembler();
    assembler.ingest({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-1",
      revision: 1,
      text: "안녕하새요",
    });
    expect(assembler.ingest({
      type: "transcript.segment",
      sequence_no: 2,
      utterance_id: "utterance-1",
      revision: 2,
      text: "안녕하세요",
    })).toEqual(expect.objectContaining({ text: "안녕하세요" }));
  });

  it("joins utterances without duplicating punctuation spacing", () => {
    expect(appendUtterance("첫 문장", "입니다.")).toBe("첫 문장 입니다.");
    expect(appendUtterance("Hello", ", world")).toBe("Hello, world");
  });
});
