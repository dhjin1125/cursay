import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { VoiceController } from "../electron/services/VoiceController";
import type { ActionBridge } from "../electron/services/ActionBridge";
import {
  type CodexAuthBroker,
} from "../electron/services/CodexAuthBroker";
import type { SettingsStore } from "../electron/services/SettingsStore";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CaptureTargetMode,
  type CommandDefinition,
  type SettingsPatch,
} from "../shared/contracts";

class FakeSettingsStore {
  private settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    onboardingComplete: true,
    postEditEnabled: false,
    commands: [{
      ...structuredClone(DEFAULT_SETTINGS.commands[0]),
      phrases: ["enter", "엔터"],
    }],
  };

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  async patch(patch: SettingsPatch): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    return this.get();
  }

  async updateCommand(command: CommandDefinition): Promise<AppSettings> {
    this.settings = { ...this.settings, commands: [structuredClone(command)] };
    return this.get();
  }
}

class FakeAuthBroker extends EventEmitter {
  readonly postEdited: string[] = [];
  readonly contexts: string[] = [];
  readonly refinementOptions: Array<{ model: string | undefined; effort: string | undefined }> = [];
  correctedText: string | null = null;
  postEditError: Error | null = null;
  postEditHandler: ((
    text: string,
    signal?: AbortSignal,
    contextText?: string,
  ) => Promise<string>) | null = null;

  async getToken(): Promise<string> {
    return "test-token";
  }

  async postEdit(
    text: string,
    signal?: AbortSignal,
    contextText = "",
    model?: string,
    effort?: string,
  ): Promise<string> {
    this.postEdited.push(text);
    this.contexts.push(contextText);
    this.refinementOptions.push({ model, effort });
    if (this.postEditHandler) return this.postEditHandler(text, signal, contextText);
    if (this.postEditError) throw this.postEditError;
    return this.correctedText ?? text;
  }

  async dispose(): Promise<void> {}
}

class FakeActionBridge extends EventEmitter {
  readonly events: string[] = [];
  readonly insertionAttempts: string[] = [];
  readonly inserted: string[] = [];
  readonly replaced: string[] = [];
  readonly executed: string[] = [];
  readonly targetContexts: Array<string | undefined> = [];
  readonly targetModes: CaptureTargetMode[] = [];
  readonly targetBundleIdSets: string[][] = [];
  helperState: "trusted" | "denied" = "trusted";
  fnMonitorAvailable = true;
  readValue = "";
  insertFailuresRemaining = 0;

  async status() {
    return {
      state: this.helperState,
      version: "0.5.0",
      fnMonitorAvailable: this.fnMonitorAvailable,
    };
  }

  async insertText(
    text: string,
    targetBundleIds: string[] = [],
    targetContextId?: string,
    targetMode: CaptureTargetMode = "configured",
  ): Promise<void> {
    this.insertionAttempts.push(text);
    if (this.insertFailuresRemaining > 0) {
      this.insertFailuresRemaining -= 1;
      throw new Error("Target is temporarily unavailable.");
    }
    this.inserted.push(text);
    this.targetContexts.push(targetContextId);
    this.targetModes.push(targetMode);
    this.targetBundleIdSets.push([...targetBundleIds]);
  }

  async execute(
    command: CommandDefinition,
    targetBundleIds: string[] = [],
    targetContextId?: string,
    targetMode: CaptureTargetMode = "configured",
  ): Promise<void> {
    this.events.push(`execute:${command.id}`);
    this.executed.push(command.id);
    this.targetContexts.push(targetContextId);
    this.targetModes.push(targetMode);
    this.targetBundleIdSets.push([...targetBundleIds]);
  }

  async readText(): Promise<string> {
    this.events.push("read");
    return this.readValue;
  }

  async replaceText(text: string): Promise<void> {
    this.events.push(`replace:${text}`);
    this.replaced.push(text);
    this.readValue = text;
  }

  async dispose(): Promise<void> {}
}

async function createController(
  targetMode: CaptureTargetMode = "pinned",
  outputMode?: "codex" | "scratch",
): Promise<{
  controller: VoiceController;
  actions: FakeActionBridge;
  auth: FakeAuthBroker;
}> {
  const settings = new FakeSettingsStore();
  if (outputMode) await settings.patch({ outputMode });
  const auth = new FakeAuthBroker();
  const actions = new FakeActionBridge();
  const controller = new VoiceController(
    settings as unknown as SettingsStore,
    auth as unknown as CodexAuthBroker,
    actions as unknown as ActionBridge,
  );
  await controller.prepareDictation({
    sampleRate: 48_000,
    forceRefresh: false,
    rollover: false,
    targetMode,
    targetBundleId: targetMode === "pinned" ? "com.openai.codex" : undefined,
    targetContextId: targetMode === "pinned"
      ? "123e4567-e89b-42d3-a456-426614174000"
      : undefined,
  });
  await controller.markDictationStarted();
  return { controller, actions, auth };
}

describe("VoiceController segment commands", () => {
  it("sends Return directly when context correction is disabled", async () => {
    const { controller, actions, auth } = await createController();
    await controller.updateSettings({ postEditEnabled: false });
    actions.readValue = "보정하지 않을 입력";

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-direct-return",
      revision: 1,
      text: "엔터",
    });

    expect(auth.postEdited).toEqual([]);
    expect(actions.replaced).toEqual([]);
    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.events).toEqual(["execute:codex-send"]);
    expect(controller.getSnapshot()).toMatchObject({
      postProcessing: false,
      postProcessingState: "idle",
      settings: { postEditEnabled: false },
    });
  });

  it("sends an exact Return command directly without whole-field post-edit", async () => {
    const { controller, actions, auth } = await createController();
    await controller.updateSettings({ postEditEnabled: true });
    actions.readValue = "절대로 전체 교체하면 안 되는 입력";

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-direct-refined-return",
      revision: 1,
      text: "엔터",
    });

    expect(auth.postEdited).toEqual([]);
    expect(actions.replaced).toEqual([]);
    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.events).toEqual(["execute:codex-send"]);
  });

  it("streams the raw prefix before a consumed Return command with Refine enabled", async () => {
    const { controller, actions, auth } = await createController();
    await controller.updateSettings({ postEditEnabled: true });
    auth.correctedText = "여기까지";

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-refined-prefix-command",
      revision: 1,
      text: "여기까지",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 2,
      utterance_id: "utterance-refined-prefix-command",
      revision: 2,
      text: "엔",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 3,
      utterance_id: "utterance-refined-prefix-command",
      revision: 3,
      text: "엔터",
    });

    expect(auth.postEdited).toEqual([]);
    expect(actions.inserted).toEqual(["여기까지"]);
    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.replaced).toEqual([]);
    expect(actions.events).toEqual(["execute:codex-send"]);
  });

  it("fires an exact stable segment without waiting for the final event", async () => {
    const { controller, actions } = await createController();

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-1",
      revision: 1,
      text: "엔터",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual([]);
    expect(actions.targetContexts).toEqual(["123e4567-e89b-42d3-a456-426614174000"]);
    expect(controller.getSnapshot().commandLog).toHaveLength(1);

    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 2,
      utterance_id: "utterance-1",
      revision: 1,
      text: "엔터",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual([]);
  });

  it("holds an unfinished command suffix and consumes it when it becomes exact", async () => {
    const { controller, actions } = await createController();

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-2",
      revision: 1,
      text: "여기까지",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 2,
      utterance_id: "utterance-2",
      revision: 2,
      text: "엔",
    });

    expect(actions.inserted).toEqual(["여기까지"]);
    expect(actions.executed).toEqual([]);
    expect(actions.targetContexts).toEqual(["123e4567-e89b-42d3-a456-426614174000"]);

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 3,
      utterance_id: "utterance-2",
      revision: 3,
      text: "엔터",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual(["여기까지"]);

    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 4,
      utterance_id: "utterance-2",
      revision: 3,
      text: "여기까지 엔터",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual(["여기까지"]);
  });

  it.each([false, true])("continues inserting speech from the same utterance after a consumed command with Refine=%s", async (postEditEnabled) => {
    const { controller, actions } = await createController();
    await controller.updateSettings({ postEditEnabled });

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-command-continuation",
      revision: 1,
      text: "엔터",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 2,
      utterance_id: "utterance-command-continuation",
      revision: 2,
      text: "엔터 계속 말한다",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual(["계속 말한다"]);

    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 3,
      utterance_id: "utterance-command-continuation",
      revision: 2,
      text: "엔터 계속 말한다",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual(["계속 말한다", " "]);
    expect(controller.getSnapshot().transcripts[0]).toMatchObject({
      text: "계속 말한다",
      route: "inserted",
      commandId: "codex-send",
    });
  });

  it("continues inserting when speech resumes as a new utterance after a command", async () => {
    const { controller, actions } = await createController();

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-command",
      revision: 1,
      text: "엔터",
    });
    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 2,
      utterance_id: "utterance-command",
      revision: 1,
      text: "엔터",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 3,
      utterance_id: "utterance-after-command",
      revision: 1,
      text: "새 입력도 계속된다",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.inserted).toEqual(["새 입력도 계속된다"]);
  });
});

describe("VoiceController streaming revisions", () => {
  it.each([false, true])("retries the complete undelivered prefix after a transient pinned-target failure with Refine=%s", async (postEditEnabled) => {
    const { controller, actions } = await createController();
    await controller.updateSettings({ postEditEnabled });
    actions.insertFailuresRemaining = 1;

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-background-retry",
      revision: 1,
      text: "백그라운드",
    });
    expect(actions.inserted).toEqual([]);

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 2,
      utterance_id: "utterance-background-retry",
      revision: 2,
      text: "백그라운드 입력 복구",
    });

    expect(actions.insertionAttempts).toEqual([
      "백그라운드",
      "백그라운드 입력 복구",
    ]);
    expect(actions.inserted).toEqual(["백그라운드 입력 복구"]);
  });

  it("accepts reused sequence numbers after a replacement session starts", async () => {
    const { controller, actions } = await createController();
    const session = (id: string) => ({
      type: "session.started",
      session: {
        session_id: id,
        status: "active",
        config: {
          provider_mode: "streaming_sse",
          transcript_delivery_mode: "segment",
        },
      },
    });

    await controller.acceptDictationEvent(session("session-1"));
    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 1,
      utterance_id: "utterance-session-1",
      revision: 1,
      text: "첫 세션",
    });
    await controller.acceptDictationEvent(session("session-2"));
    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 1,
      utterance_id: "utterance-session-2",
      revision: 1,
      text: "둘째 세션",
    });

    expect(actions.inserted).toEqual(["첫 세션 ", "둘째 세션 "]);
  });

  it("routes plain Fn text to live focus without an AX context or app allowlist", async () => {
    const { controller, actions } = await createController("live", "scratch");

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-live-focus",
      revision: 1,
      text: "앱을 바꿔도 계속 입력",
    });

    expect(actions.inserted).toEqual(["앱을 바꿔도 계속 입력"]);
    expect(actions.targetContexts).toEqual([undefined]);
    expect(actions.targetModes).toEqual(["live"]);
    expect(actions.targetBundleIdSets).toEqual([[]]);
    expect(controller.getSnapshot().scratchText).toBe("");
  });

  it("routes a plain-Fn spoken hotkey to live focus without contextual post-edit", async () => {
    const { controller, actions, auth } = await createController("live");
    actions.readValue = "이 값은 live 모드에서 읽지 않아야 한다";

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-live-command",
      revision: 1,
      text: "엔터",
    });

    expect(actions.executed).toEqual(["codex-send"]);
    expect(actions.targetContexts).toEqual([undefined]);
    expect(actions.targetModes).toEqual(["live"]);
    expect(actions.targetBundleIdSets).toEqual([[]]);
    expect(auth.postEdited).toEqual([]);
  });

  it("rebases a corrected partial so later suffixes continue appending", async () => {
    const { controller, actions } = await createController();

    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 1,
      utterance_id: "utterance-correction",
      revision: 1,
      text: "안녕하새요",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 2,
      utterance_id: "utterance-correction",
      revision: 2,
      text: "안녕하세요",
    });
    await controller.acceptDictationEvent({
      type: "transcript.segment",
      sequence_no: 3,
      utterance_id: "utterance-correction",
      revision: 3,
      text: "안녕하세요 여러분",
    });

    expect(actions.inserted).toEqual(["안녕하새요", " 여러분"]);

    await controller.acceptDictationEvent({
      type: "transcript.final",
      sequence_no: 4,
      utterance_id: "utterance-correction",
      revision: 3,
      text: "안녕하세요 여러분",
    });

    expect(actions.inserted).toEqual(["안녕하새요", " 여러분", " "]);
  });
});

describe("VoiceController permission recovery", () => {
  it("returns a completed setup to Accessibility onboarding when AX or Fn is unavailable", async () => {
    const settings = new FakeSettingsStore();
    const auth = new FakeAuthBroker();
    const actions = new FakeActionBridge();
    actions.helperState = "denied";
    actions.fnMonitorAvailable = false;
    const controller = new VoiceController(
      settings as unknown as SettingsStore,
      auth as unknown as CodexAuthBroker,
      actions as unknown as ActionBridge,
    );

    await controller.initialize();

    expect(controller.getSnapshot().settings).toMatchObject({
      onboardingComplete: false,
      onboardingStep: 2,
    });
  });
});
