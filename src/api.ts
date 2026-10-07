import {
  createInitialSnapshot,
  type CaptureLifecycleEvent,
  type CaptureRequest,
  type CommandDefinition,
  type RendererEvent,
  type SettingsPatch,
  type VoiceControlApi,
  type VoiceSnapshot,
} from "@shared/contracts";
import { CaptureStateMachine } from "@shared/capture-state";

function createBrowserPreviewApi(): VoiceControlApi {
  let snapshot = createInitialSnapshot();
  snapshot.accessibility = "denied";
  snapshot.helperVersion = "0.1.0";
  const capture = new CaptureStateMachine();
  const listeners = new Set<(event: RendererEvent) => void>();
  const publish = () => {
    for (const listener of listeners) listener({ type: "snapshot", snapshot: structuredClone(snapshot) });
  };
  const copy = () => Promise.resolve(structuredClone(snapshot));
  const publishCapture = () => {
    const state = capture.getState();
    for (const listener of listeners) listener({ type: "capture-state", state });
    return structuredClone(state);
  };

  return {
    getSnapshot: copy,
    getCaptureState: () => Promise.resolve(capture.getState()),
    async requestCapture(action: CaptureRequest) {
      const transition = capture.request(action);
      if (transition.changed) publishCapture();
      return transition.state;
    },
    reportCaptureLifecycle(event: CaptureLifecycleEvent) {
      const transition = capture.acceptLifecycle(event);
      if (transition.changed) publishCapture();
    },
    async start() {
      throw new Error("Microphone capture is available only inside the desktop app.");
    },
    async stop() {
      snapshot.phase = "disabled";
      publish();
      return copy();
    },
    sendAudio() {},
    sendMicrophoneLevel() {},
    async updateSettings(patch: SettingsPatch) {
      snapshot.settings = { ...snapshot.settings, ...patch };
      publish();
      return copy();
    },
    async updateCommand(command: CommandDefinition) {
      snapshot.settings.commands = snapshot.settings.commands
        .filter((item) => item.id !== command.id)
        .concat(command);
      publish();
      return copy();
    },
    async requestAccessibility() {
      return copy();
    },
    async refreshAccessibility() {
      return copy();
    },
    async openAccessibilitySettings() {},
    async requestMicrophonePermission() {
      snapshot.microphonePermission = "granted";
      publish();
      return copy();
    },
    async refreshMicrophonePermission() {
      return copy();
    },
    async checkCodexAuth() {
      snapshot.auth = "ready";
      publish();
      return copy();
    },
    async showWindow() {},
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let previewApi: VoiceControlApi | null = null;

export function getVoiceApi(): VoiceControlApi {
  if (window.voiceControl) return window.voiceControl;
  previewApi ??= createBrowserPreviewApi();
  return previewApi;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected application error.";
}

export function isElectronRuntime(): boolean {
  return Boolean(window.voiceControl);
}
