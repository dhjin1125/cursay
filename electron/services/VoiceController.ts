import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AccessibilityState,
  CaptureTargetMode,
  CommandDefinition,
  CommandLogEntry,
  DictationPrepareRequest,
  DictationPrepareResult,
  DictationTransportFailureCode,
  PushToTalkEvent,
  TargetBindingEvent,
  SettingsPatch,
  TranscriptEntry,
  VoiceSnapshot,
  MicrophonePermissionState,
  PostProcessingState,
} from "../../shared/contracts.js";
import { createInitialSnapshot } from "../../shared/contracts.js";
import {
  createSessionStartFrame,
  parseDictationEvent,
  type DictationEvent,
} from "../../shared/dictation-protocol.js";
import {
  CommandRouter,
  normalizeCommandText,
} from "../../shared/command-router.js";
import {
  appendOnlyDifference,
  appendUtterance,
  TranscriptAssembler,
  type TranscriptUpdate,
} from "../../shared/transcript-assembler.js";
import { ActionBridge, type CapturedField } from "./ActionBridge.js";
import {
  CodexAuthBroker,
  POST_EDIT_TIMEOUT_MS,
  PostEditCancelledError,
  PostEditTimeoutError,
} from "./CodexAuthBroker.js";
import { SettingsStore } from "./SettingsStore.js";

const DICTATION_URL = "wss://chatgpt.com/backend-api/dictation/stream";

interface PostProcessingOperation {
  id: string;
  controller: AbortController;
}

interface FieldRefinement extends PostProcessingOperation {
  target: Promise<CapturedField | null>;
  targetContextId: string | null;
  targetError: string | null;
  cleanup: Promise<void> | null;
}

export class VoiceController extends EventEmitter {
  private snapshot: VoiceSnapshot;
  private assembler = new TranscriptAssembler();
  private router = new CommandRouter();
  private readonly deliveredTextByUtterance = new Map<string, string>();
  private readonly segmentCommandByUtterance = new Map<string, {
    commandId: string;
    consumeTranscript: boolean;
    consumedThroughText: string;
    status: CommandLogEntry["status"];
  }>();
  private sessionTargetBundleIds: string[] | null = null;
  private sessionTargetContextId: string | null = null;
  private sessionTargetMode: CaptureTargetMode = "configured";
  private operation: Promise<void> = Promise.resolve();
  private finishingField: FieldRefinement | null = null;
  private activePostProcessing: PostProcessingOperation | null = null;
  private postProcessingResetTimer: NodeJS.Timeout | null = null;
  private acceptingDictationEvents = false;
  private dictationEpoch = 0;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly authBroker: CodexAuthBroker,
    private readonly actionBridge: ActionBridge,
  ) {
    super();
    this.snapshot = createInitialSnapshot(settingsStore.get());
    this.authBroker.on("state", (state) => {
      this.snapshot.auth = state;
      this.publish();
    });
    this.actionBridge.on("push-to-talk", (event: PushToTalkEvent) => {
      this.emit("push-to-talk", event);
    });
    this.actionBridge.on("refinement-cancelled", (contextId: string) => {
      if (this.finishingField?.targetContextId === contextId) {
        this.cancelPendingAction("Refinement was cancelled.");
      }
    });
    this.actionBridge.on("disconnected", () => {
      this.cancelPendingAction("The input field connection was lost.");
    });
    this.actionBridge.on("target-binding", (event: TargetBindingEvent) => {
      this.emit("target-binding", event);
    });
  }

  async initialize(): Promise<void> {
    const helper = await this.actionBridge.status();
    this.snapshot.accessibility = helper.state;
    this.snapshot.helperVersion = helper.version;
    this.snapshot.fnMonitorAvailable = helper.fnMonitorAvailable;
    await this.requireAccessibilityOnboarding();
    this.publish();
  }

  getSnapshot(): VoiceSnapshot {
    return structuredClone(this.snapshot);
  }

  async prepareDictation(request: DictationPrepareRequest): Promise<DictationPrepareResult> {
    let result: DictationPrepareResult | null = null;
    await this.enqueue(async () => {
      const retryingInitialConnection = request.forceRefresh &&
        !request.rollover &&
        this.snapshot.phase === "connecting";
      if (
        !request.rollover &&
        !retryingInitialConnection &&
        this.snapshot.phase !== "disabled" &&
        this.snapshot.phase !== "error"
      ) {
        throw new Error("Cursay is already active.");
      }
      if (
        request.rollover &&
        (this.snapshot.phase === "disabled" || this.snapshot.phase === "closing")
      ) {
        throw new Error("Cursay cannot roll over an inactive session.");
      }
      if (this.snapshot.settings.provider === "local-whisper") {
        throw new Error("Local Whisper runtime is not installed yet. Select CODEX STREAM.");
      }
      try {
        const visibleConnection = !request.rollover || request.reconnectMode === "recovery";
        if (visibleConnection) {
          this.snapshot.phase = "connecting";
          this.snapshot.error = null;
        }
        if (!request.forceRefresh) {
          if (!request.rollover) {
            this.dictationEpoch += 1;
            this.resetStreamingState();
            this.setSessionTarget(
              request.targetMode ?? "configured",
              request.targetBundleId,
              request.targetContextId,
            );
            this.snapshot.sessionStartedAt = null;
          }
          if (request.rollover) this.snapshot.reconnectCount += 1;
        }
        this.acceptingDictationEvents = true;
        this.publish();
        const token = await this.authBroker.getToken(request.forceRefresh);
        result = {
          connection: {
            websocketUrl: DICTATION_URL,
            protocols: ["chatgpt-dictation", `openai-bearer.${token}`, "codex-desktop"],
            sessionStart: createSessionStartFrame(
              request.sampleRate,
              this.snapshot.settings.silenceDurationMs,
            ),
          },
          snapshot: this.getSnapshot(),
        };
      } catch (error) {
        if (!request.rollover) this.fail(error);
        throw error;
      }
    });
    if (!result) throw new Error("Dictation connection preparation failed.");
    return result;
  }

  async markDictationStarted(): Promise<VoiceSnapshot> {
    await this.enqueue(async () => {
      if (this.snapshot.phase !== "connecting") return;
      this.snapshot.phase = "listening";
      this.snapshot.sessionStartedAt = Date.now();
      this.snapshot.error = null;
      this.publish();
    });
    return this.getSnapshot();
  }

  async acceptDictationEvent(value: unknown): Promise<void> {
    if (
      !this.acceptingDictationEvents ||
      this.snapshot.phase === "disabled" ||
      this.snapshot.phase === "closing" ||
      this.snapshot.phase === "error"
    ) {
      return;
    }
    let event: DictationEvent;
    try {
      event = parseDictationEvent(value);
    } catch {
      this.snapshot.error = "An incompatible dictation event was ignored.";
      this.publish();
      return;
    }
    const epoch = this.dictationEpoch;
    await this.enqueue(async () => {
      if (!this.acceptingDictationEvents || epoch !== this.dictationEpoch) return;
      await this.handleDictationEvent(event);
    });
  }

  async reportTransportFailure(code: DictationTransportFailureCode): Promise<VoiceSnapshot> {
    const messages: Record<DictationTransportFailureCode, string> = {
      "connection-failed": "Dictation connection failed in the Chromium transport.",
      "connection-closed": "Dictation connection closed unexpectedly.",
      "session-timeout": "Dictation session did not start in time.",
      "protocol-error": "Dictation returned an incompatible event.",
    };
    await this.enqueue(async () => {
      if (this.snapshot.phase === "disabled" || this.snapshot.phase === "closing") return;
      this.fail(new Error(messages[code]));
    });
    return this.getSnapshot();
  }

  async stop(): Promise<VoiceSnapshot> {
    this.acceptingDictationEvents = false;
    this.dictationEpoch += 1;
    this.cancelPendingAction("Voice capture was stopped.");
    return this.finishDictation();
  }

  prepareToFinish(): void {
    if (this.finishingField || !this.snapshot.settings.postEditEnabled) return;
    const field: FieldRefinement = {
      id: randomUUID(),
      controller: new AbortController(),
      target: Promise.resolve(null),
      targetContextId: null,
      targetError: null,
      cleanup: null,
    };
    this.finishingField = field;
    // Capture before waiting for the final transcript or a model response.
    field.target = this.actionBridge.captureRefinementTarget().then((target) => {
      field.targetContextId = target.targetContextId;
      return target;
    }).catch((error: unknown) => {
      field.targetError = error instanceof Error ? error.message : "The focused field is unavailable.";
      return null;
    });
  }

  async finishDictation(): Promise<VoiceSnapshot> {
    await this.enqueue(async () => {
      this.acceptingDictationEvents = false;
      this.snapshot.phase = "closing";
      this.publish();
      await this.refineFinishedField();
      this.snapshot.phase = "disabled";
      this.snapshot.sessionStartedAt = null;
      this.snapshot.deliveryMode = "unknown";
      this.snapshot.activeTargetBundleId = null;
      this.resetStreamingState(false);
      this.publish();
    });
    return this.getSnapshot();
  }

  async updateSettings(patch: SettingsPatch): Promise<VoiceSnapshot> {
    const correctionWasEnabled = this.snapshot.settings.postEditEnabled;
    this.snapshot.settings = await this.settingsStore.patch(patch);
    if (correctionWasEnabled && !this.snapshot.settings.postEditEnabled) {
      this.cancelPendingAction("Refine was disabled.");
    }
    this.publish();
    return this.getSnapshot();
  }

  async updateCommand(command: CommandDefinition): Promise<VoiceSnapshot> {
    this.snapshot.settings = await this.settingsStore.updateCommand(command);
    this.publish();
    return this.getSnapshot();
  }

  async requestAccessibility(): Promise<VoiceSnapshot> {
    this.snapshot.accessibility = await this.actionBridge.requestAccessibility();
    this.publish();
    return this.getSnapshot();
  }

  async refreshAccessibility(): Promise<VoiceSnapshot> {
    const helper = await this.actionBridge.refreshStatus();
    this.snapshot.accessibility = helper.state;
    this.snapshot.helperVersion = helper.version;
    this.snapshot.fnMonitorAvailable = helper.fnMonitorAvailable;
    await this.requireAccessibilityOnboarding();
    this.publish();
    return this.getSnapshot();
  }

  setMicrophonePermission(state: MicrophonePermissionState): VoiceSnapshot {
    this.snapshot.microphonePermission = state;
    this.publish();
    return this.getSnapshot();
  }

  async checkCodexAuth(): Promise<VoiceSnapshot> {
    this.snapshot.error = null;
    try {
      await this.authBroker.getToken(false);
    } catch (error) {
      this.snapshot.error = error instanceof Error ? error.message : "Codex authentication failed.";
    }
    this.publish();
    return this.getSnapshot();
  }

  async dispose(): Promise<void> {
    this.cancelPendingAction("Voice Control was closed.");
    if (this.finishingField) await this.releaseRefinementField(this.finishingField);
    this.clearPostProcessingResetTimer();
    await this.actionBridge.dispose();
    await this.authBroker.dispose();
  }

  cancelPendingAction(message = "Refinement was cancelled."): boolean {
    const field = this.finishingField;
    if (!field || field.controller.signal.aborted) return false;
    field.controller.abort(new PostEditCancelledError(message));
    void this.releaseRefinementField(field);
    this.activePostProcessing = null;
    this.clearPostProcessingResetTimer();
    this.snapshot.postProcessing = false;
    this.snapshot.postProcessingState = "cancelled";
    this.snapshot.postProcessingStartedAt = null;
    this.publish();
    this.schedulePostProcessingReset("cancelled", 800);
    return true;
  }

  private async handleDictationEvent(event: DictationEvent): Promise<void> {
    switch (event.type) {
      case "session.started":
        this.beginTransportSession();
        this.snapshot.deliveryMode = (
          event as Extract<DictationEvent, { session: unknown }>
        ).session.config.transcript_delivery_mode;
        this.publish();
        return;
      case "speech.started":
        this.snapshot.phase = "speech";
        this.publish();
        return;
      case "speech.stopped":
        this.snapshot.phase = "awaiting-final";
        this.publish();
        return;
      case "transcript.segment": {
        const segment = this.assembler.ingest(event);
        const sourceText = typeof event.text === "string" ? event.text : segment?.text ?? "";
        if (segment) {
          await this.routeSegment(segment, sourceText);
        }
        this.publish();
        return;
      }
      case "transcript.final": {
        const final = this.assembler.ingest(event);
        if (final) {
          await this.routeFinal(final);
        }
        if (this.snapshot.phase !== "error") this.snapshot.phase = "listening";
        this.publish();
        return;
      }
      case "transcript.failed":
        this.snapshot.phase = "listening";
        this.snapshot.error = "One utterance could not be transcribed.";
        this.publish();
        return;
      case "session.error":
        this.fail(new Error("The dictation session reported an error."));
        return;
      default:
        return;
    }
  }

  private async routeSegment(segment: TranscriptUpdate, sourceText: string): Promise<void> {
    const previous = this.deliveredTextByUtterance.get(segment.utteranceId) ?? "";
    const difference = appendOnlyDifference(previous, segment.text);
    const commandCandidate = difference?.trim() ?? "";
    const sourceCandidate = sourceText.trim();
    const candidates = [...new Set([commandCandidate, sourceCandidate])].filter(Boolean);
    const matched = difference === null
      ? null
      : candidates.reduce<ReturnType<CommandRouter["route"]>>(
          (result, candidate) => result ?? this.router.route(
            candidate,
            this.snapshot.settings.commands,
          ),
          null,
        );

    if (matched) {
      const status = await this.runCommand(matched.command);
      if (matched.command.consumeTranscript) {
        // Account for the command suffix without typing it. Any later suffix
        // remains appendable after the hotkey has moved focus or submitted.
        this.deliveredTextByUtterance.set(segment.utteranceId, segment.text);
      } else {
        await this.commitTranscript(segment, false);
      }
      this.segmentCommandByUtterance.set(segment.utteranceId, {
        commandId: matched.command.id,
        consumeTranscript: matched.command.consumeTranscript,
        consumedThroughText: segment.text,
        status,
      });
      this.upsertTranscript({
        id: randomUUID(),
        utteranceId: segment.utteranceId,
        text: matched.command.consumeTranscript ? "" : segment.text,
        createdAt: Date.now(),
        stage: "segment",
        route: status === "executed" ? "command" : "blocked",
        targetMode: this.sessionTargetMode,
        commandId: matched.command.id,
      });
      return;
    }

    if (
      difference !== null &&
      candidates.some((candidate) => this.couldBecomeCommand(candidate))
    ) {
      this.upsertTranscript({
        id: randomUUID(),
        utteranceId: segment.utteranceId,
        text: segment.text,
        createdAt: Date.now(),
        stage: "segment",
        route: "preview",
        targetMode: this.sessionTargetMode,
      });
      return;
    }

    const priorCommand = this.segmentCommandByUtterance.get(segment.utteranceId);
    const isFirstContinuationAfterConsumedCommand =
      priorCommand?.consumeTranscript === true &&
      previous === priorCommand.consumedThroughText;
    const route = await this.commitTranscript(
      segment,
      false,
      true,
      isFirstContinuationAfterConsumedCommand,
    );
    this.upsertTranscript({
      id: randomUUID(),
      utteranceId: segment.utteranceId,
      text: segment.text,
      createdAt: Date.now(),
      stage: "segment",
      route,
      targetMode: this.sessionTargetMode,
    });
  }

  private async routeFinal(final: TranscriptUpdate): Promise<void> {
    this.snapshot.utteranceCount += 1;
    const segmentCommand = this.segmentCommandByUtterance.get(final.utteranceId);
    if (segmentCommand) {
      this.segmentCommandByUtterance.delete(final.utteranceId);
      const previous = this.deliveredTextByUtterance.get(final.utteranceId) ?? "";
      const remainder = appendOnlyDifference(previous, final.text);
      const deliveredContinuation = appendOnlyDifference(
        segmentCommand.consumedThroughText,
        previous,
      );
      const hasDeliveredContinuation =
        typeof deliveredContinuation === "string" &&
        deliveredContinuation.trim().length > 0;
      const hasFinalRemainder =
        typeof remainder === "string" && remainder.trim().length > 0;
      const hasContinuation = hasDeliveredContinuation || hasFinalRemainder;
      let route: TranscriptEntry["route"];
      if (remainder === "" && !hasDeliveredContinuation) {
        route = segmentCommand.status === "executed" ? "command" : "blocked";
      } else {
        route = await this.commitTranscript(
          final,
          true,
          !segmentCommand.consumeTranscript || hasDeliveredContinuation,
          segmentCommand.consumeTranscript && !hasDeliveredContinuation,
        );
      }
      const fullContinuation = appendOnlyDifference(
        segmentCommand.consumedThroughText,
        final.text,
      );
      this.upsertTranscript({
        id: randomUUID(),
        utteranceId: final.utteranceId,
        text: segmentCommand.consumeTranscript
          ? fullContinuation?.trim() ?? remainder?.trim() ?? ""
          : final.text,
        createdAt: Date.now(),
        stage: "final",
        route: hasContinuation
          ? route
          : segmentCommand.status === "executed"
            ? "command"
            : "blocked",
        targetMode: this.sessionTargetMode,
        commandId: segmentCommand.commandId,
      });
      return;
    }

    const matched = this.router.route(final.text, this.snapshot.settings.commands);
    if (matched) {
      const delivered = this.deliveredTextByUtterance.get(final.utteranceId) ?? "";
      if (matched.command.consumeTranscript && delivered) {
        const route = await this.commitTranscript(final, true);
        this.snapshot.error = "A voice command was suppressed because partial text was already inserted.";
        this.upsertTranscript({
          id: randomUUID(),
          utteranceId: final.utteranceId,
          text: final.text,
          createdAt: Date.now(),
          stage: "final",
          route: route === "inserted" ? "blocked" : route,
          targetMode: this.sessionTargetMode,
          commandId: matched.command.id,
        });
        return;
      }
      const status = await this.runCommand(matched.command);
      this.upsertTranscript({
        id: randomUUID(),
        utteranceId: final.utteranceId,
        text: matched.command.consumeTranscript ? "" : final.text,
        createdAt: Date.now(),
        stage: "final",
        route: status === "executed" ? "command" : "blocked",
        targetMode: this.sessionTargetMode,
        commandId: matched.command.id,
      });
      if (!matched.command.consumeTranscript) await this.commitTranscript(final, true);
      return;
    }

    const route = await this.commitTranscript(final, true);
    this.upsertTranscript({
      id: randomUUID(),
      utteranceId: final.utteranceId,
      text: final.text,
      createdAt: Date.now(),
      stage: "final",
      route,
      targetMode: this.sessionTargetMode,
    });
  }

  private async refineFinishedField(): Promise<void> {
    const field = this.finishingField;
    if (!field) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      field.controller.signal.throwIfAborted();
      const target = await field.target;
      field.controller.signal.throwIfAborted();
      if (!target) throw new Error(field.targetError ?? "The focused field is unavailable.");
      const original = await this.actionBridge.beginRefinement(target);
      field.controller.signal.throwIfAborted();
      if (!original.trim()) return;

      this.clearPostProcessingResetTimer();
      this.activePostProcessing = field;
      this.snapshot.postProcessing = true;
      this.snapshot.postProcessingState = "correcting";
      this.snapshot.postProcessingStartedAt = Date.now();
      this.snapshot.error = null;
      this.publish();
      timeout = setTimeout(() => field.controller.abort(new PostEditTimeoutError()), POST_EDIT_TIMEOUT_MS);
      const signal = field.controller.signal;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let corrected: string;
      try {
        corrected = await Promise.race([
          this.authBroker.postEdit(
            original,
            signal,
            this.snapshot.settings.postEditModel,
            this.snapshot.settings.postEditReasoningEffort,
          ),
          aborted,
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      signal.throwIfAborted();
      if (!corrected.trim()) throw new Error("Refine returned an empty result. Your text was kept.");
      await this.actionBridge.applyRefinement(target, original, corrected);
      this.finishPostProcessing(field, "succeeded");
    } catch (error) {
      const reason = field.controller.signal.aborted ? field.controller.signal.reason : error;
      const result = reason instanceof PostEditTimeoutError ? "timed-out"
        : reason instanceof PostEditCancelledError ? "cancelled" : "failed";
      if (result !== "cancelled") {
        this.snapshot.error = reason instanceof Error ? reason.message : "Refine failed. Your text was kept.";
      }
      if (this.activePostProcessing?.id === field.id) {
        this.finishPostProcessing(field, result);
      } else if (result !== "cancelled") {
        this.snapshot.postProcessingState = result;
        this.schedulePostProcessingReset(result, 1_800);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      await this.releaseRefinementField(field);
      if (this.finishingField === field) this.finishingField = null;
    }
  }

  private releaseRefinementField(field: FieldRefinement): Promise<void> {
    field.cleanup ??= (async () => {
      const target = await field.target;
      if (!target) return;
      await this.actionBridge.endRefinement(target).catch(() => undefined);
      await this.actionBridge.releaseTarget(target.targetContextId).catch(() => undefined);
    })();
    return field.cleanup;
  }

  private async deliveryTarget(fallback: string[]): Promise<{
    bundleIds: string[];
    contextId: string | undefined;
    mode: CaptureTargetMode;
  }> {
    if (this.sessionTargetMode === "live" && this.finishingField) {
      const field = this.finishingField;
      const target = await field.target;
      field.controller.signal.throwIfAborted();
      if (!target) throw new Error("The field at the end of recording is unavailable.");
      return { bundleIds: [target.targetBundleId], contextId: target.targetContextId, mode: "pinned" };
    }
    return {
      bundleIds: this.resolveTargetBundleIds(fallback),
      contextId: this.sessionTargetContextId ?? undefined,
      mode: this.sessionTargetMode,
    };
  }

  private async commitTranscript(
    update: TranscriptUpdate,
    final: boolean,
    terminateDivergentFinal = true,
    trimConsumedCommandBoundary = false,
  ): Promise<TranscriptEntry["route"]> {
    const previous = this.deliveredTextByUtterance.get(update.utteranceId) ?? "";
    const difference = appendOnlyDifference(previous, update.text);

    if (
      this.sessionTargetMode === "configured" &&
      this.snapshot.settings.outputMode === "scratch" &&
      !this.sessionTargetBundleIds
    ) {
      if (difference === null) {
        if (previous && this.snapshot.scratchText.endsWith(previous)) {
          this.snapshot.scratchText = `${this.snapshot.scratchText.slice(0, -previous.length)}${update.text}`;
        }
      } else if (!previous) {
        this.snapshot.scratchText = appendUtterance(this.snapshot.scratchText, update.text);
      } else {
        this.snapshot.scratchText += difference;
      }
      this.deliveredTextByUtterance.set(update.utteranceId, update.text);
      return "scratch";
    }

    if (difference === null) {
      // Streaming ASR may revise an earlier word after its provisional text was
      // already delivered. Rewriting user text would be destructive, but keeping
      // the old comparison basis permanently blocks every later append for this
      // utterance. Rebase on the newest revision so subsequent stable suffixes
      // continue flowing. On a divergent final, still terminate the utterance
      // with a separator so the next one cannot collapse into the old text.
      this.deliveredTextByUtterance.set(update.utteranceId, update.text);
      if (final && terminateDivergentFinal) {
        try {
          const target = await this.deliveryTarget(this.snapshot.settings.targetBundleIds);
          await this.actionBridge.insertText(
            " ",
            target.bundleIds,
            target.contextId,
            target.mode,
          );
        } catch {
          // The transcript remains marked blocked; never retry destructively.
        }
      }
      return "blocked";
    }
    const appendable = trimConsumedCommandBoundary
      ? difference.replace(/^\s+/u, "")
      : difference;
    const payload = `${appendable}${final ? " " : ""}`;
    if (!payload) {
      this.deliveredTextByUtterance.set(update.utteranceId, update.text);
      return "inserted";
    }
    try {
      const target = await this.deliveryTarget(this.snapshot.settings.targetBundleIds);
      await this.actionBridge.insertText(
        payload,
        target.bundleIds,
        target.contextId,
        target.mode,
      );
      this.deliveredTextByUtterance.set(update.utteranceId, update.text);
      return "inserted";
    } catch {
      return "blocked";
    }
  }

  private couldBecomeCommand(text: string): boolean {
    const normalized = normalizeCommandText(text);
    if (!normalized) return false;
    return this.snapshot.settings.commands.some((command) =>
      command.enabled && command.phrases.some((phrase) =>
        normalizeCommandText(phrase).startsWith(normalized),
      ),
    );
  }

  private async runCommand(command: CommandDefinition): Promise<CommandLogEntry["status"]> {
    let status: CommandLogEntry["status"] = "executed";
    try {
      const target = await this.deliveryTarget(command.targetBundleIds);
      await this.actionBridge.execute(
        command,
        target.bundleIds,
        target.contextId,
        target.mode,
      );
    } catch {
      status = "blocked";
      this.snapshot.error = "The voice command could not be sent to the captured target.";
    }
    this.snapshot.commandLog.unshift({
      id: randomUUID(),
      commandId: command.id,
      createdAt: Date.now(),
      status,
    });
    this.snapshot.commandLog = this.snapshot.commandLog.slice(0, 20);
    return status;
  }

  private finishPostProcessing(
    operation: PostProcessingOperation,
    result: Exclude<PostProcessingState, "idle" | "correcting">,
  ): void {
    if (this.activePostProcessing?.id !== operation.id) return;
    this.activePostProcessing = null;
    this.snapshot.postProcessing = false;
    this.snapshot.postProcessingState = result;
    this.snapshot.postProcessingStartedAt = null;
    this.publish();
    this.schedulePostProcessingReset(
      result,
      result === "succeeded" ? 700 : 1_800,
    );
  }

  private schedulePostProcessingReset(
    expected: Exclude<PostProcessingState, "idle" | "correcting">,
    milliseconds: number,
  ): void {
    this.clearPostProcessingResetTimer();
    this.postProcessingResetTimer = setTimeout(() => {
      this.postProcessingResetTimer = null;
      if (
        this.snapshot.postProcessing ||
        this.snapshot.postProcessingState !== expected
      ) {
        return;
      }
      this.snapshot.postProcessingState = "idle";
      this.publish();
    }, milliseconds);
    this.postProcessingResetTimer.unref();
  }

  private clearPostProcessingResetTimer(): void {
    if (this.postProcessingResetTimer) {
      clearTimeout(this.postProcessingResetTimer);
      this.postProcessingResetTimer = null;
    }
  }

  private upsertTranscript(entry: TranscriptEntry): void {
    const previousIndex = this.snapshot.transcripts.findIndex(
      (item) => item.utteranceId === entry.utteranceId,
    );
    if (previousIndex >= 0) {
      const [previous] = this.snapshot.transcripts.splice(previousIndex, 1);
      entry.id = previous.id;
    }
    this.snapshot.transcripts.unshift(entry);
    this.snapshot.transcripts = this.snapshot.transcripts.slice(0, 24);
  }

  private resetStreamingState(resetPostProcessing = true): void {
    if (resetPostProcessing) {
      this.clearPostProcessingResetTimer();
      this.activePostProcessing = null;
      this.snapshot.postProcessing = false;
      this.snapshot.postProcessingState = "idle";
      this.snapshot.postProcessingStartedAt = null;
    }
    this.assembler.reset();
    this.deliveredTextByUtterance.clear();
    this.segmentCommandByUtterance.clear();
    this.router.reset();
    this.sessionTargetBundleIds = null;
    this.sessionTargetContextId = null;
    this.sessionTargetMode = "configured";
  }

  private beginTransportSession(): void {
    this.assembler.reset();
    this.deliveredTextByUtterance.clear();
    this.segmentCommandByUtterance.clear();
  }

  private setSessionTarget(
    targetMode: CaptureTargetMode,
    targetBundleId: string | undefined,
    targetContextId: string | undefined,
  ): void {
    this.sessionTargetMode = targetMode;
    if (targetMode === "live") {
      this.sessionTargetBundleIds = null;
      this.sessionTargetContextId = null;
      this.snapshot.activeTargetBundleId = null;
      return;
    }
    const valid = typeof targetBundleId === "string" &&
      targetBundleId.length > 0 &&
      targetBundleId.length <= 240 &&
      /^[A-Za-z0-9.-]+$/.test(targetBundleId) &&
      targetBundleId !== "local.minkyu.CodexVoiceControl" &&
      targetBundleId !== "local.minkyu.CodexVoiceActionHelper";
    this.sessionTargetBundleIds = valid ? [targetBundleId] : null;
    const validContextId = valid &&
      typeof targetContextId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetContextId)
      ? targetContextId.toLowerCase()
      : null;
    if (targetMode === "pinned" && (!valid || !validContextId)) {
      throw new Error("Control+Fn could not pin the focused editable field.");
    }
    this.sessionTargetContextId = validContextId;
    this.snapshot.activeTargetBundleId = valid
      ? targetBundleId
      : this.snapshot.settings.targetBundleIds[0] ?? null;
  }

  private resolveTargetBundleIds(fallback: string[]): string[] {
    if (this.sessionTargetMode === "live") return [];
    return this.sessionTargetBundleIds ?? fallback;
  }

  private fail(error: unknown): void {
    this.acceptingDictationEvents = false;
    this.dictationEpoch += 1;
    this.cancelPendingAction("Voice capture failed.");
    this.snapshot.phase = "error";
    this.snapshot.error = error instanceof Error ? error.message : "Cursay stopped unexpectedly.";
    this.publish();
  }

  private async requireAccessibilityOnboarding(): Promise<void> {
    if (
      this.snapshot.accessibility === "trusted" &&
      this.snapshot.fnMonitorAvailable
    ) {
      return;
    }
    if (
      !this.snapshot.settings.onboardingComplete &&
      this.snapshot.settings.onboardingStep === 2
    ) {
      return;
    }
    this.snapshot.settings = await this.settingsStore.patch({
      onboardingComplete: false,
      onboardingStep: 2,
    });
  }

  private publish(): void {
    this.emit("snapshot", this.getSnapshot());
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const current = this.operation.then(task, task);
    this.operation = current.catch(() => undefined);
    return current;
  }
}
