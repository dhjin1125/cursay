import type {
  SessionStartFrame,
  TranscriptDeliveryMode,
} from "./dictation-protocol.js";

export type VoicePhase =
  | "disabled"
  | "connecting"
  | "listening"
  | "speech"
  | "awaiting-final"
  | "closing"
  | "error";

export type AuthState = "idle" | "connecting" | "ready" | "expired" | "error";
export type AccessibilityState = "unknown" | "unavailable" | "denied" | "trusted";
export type MicrophonePermissionState =
  | "unknown"
  | "not-determined"
  | "denied"
  | "restricted"
  | "granted";
export type OutputMode = "scratch" | "codex";
export type ProviderMode = "codex-stream" | "local-whisper";
export type ManagerScreen = "history" | "commands" | "settings";
export type PostProcessingState =
  | "idle"
  | "correcting"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled";
export const POST_EDIT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;
export type PostEditModel = (typeof POST_EDIT_MODELS)[number];
export const POST_EDIT_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PostEditReasoningEffort = (typeof POST_EDIT_REASONING_EFFORTS)[number];

export interface HotkeyAction {
  type: "hotkey";
  key: "return" | "escape" | "tab" | "space";
  modifiers: Array<"command" | "option" | "control" | "shift">;
}

export interface CommandDefinition {
  id: string;
  label: string;
  phrases: string[];
  match: "exact-segment-or-final";
  consumeTranscript: boolean;
  cooldownMs: number;
  targetBundleIds: string[];
  action: HotkeyAction;
  enabled: boolean;
}

export interface AppSettings {
  provider: ProviderMode;
  outputMode: OutputMode;
  targetBundleIds: string[];
  silenceDurationMs: number;
  persistTranscriptHistory: boolean;
  launchAtLogin: boolean;
  postEditEnabled: boolean;
  postEditModel: PostEditModel;
  postEditReasoningEffort: PostEditReasoningEffort;
  onboardingComplete: boolean;
  onboardingStep: number;
  commands: CommandDefinition[];
}

export interface TranscriptEntry {
  id: string;
  utteranceId: string;
  text: string;
  createdAt: number;
  stage: "segment" | "final";
  route: "preview" | "scratch" | "inserted" | "command" | "blocked";
  targetMode?: CaptureTargetMode;
  commandId?: string;
}

export type TargetBindingState =
  | "none"
  | "foreground"
  | "background"
  | "rebinding"
  | "invalid";

export type TargetBindingInvalidReason =
  | "process-terminated"
  | "input-unavailable"
  | null;

export type CaptureTargetMode = "live" | "pinned" | "configured";

export interface PushToTalkEvent {
  state: "down" | "up";
  targetMode: Exclude<CaptureTargetMode, "configured">;
  targetBundleId: string | null;
  targetContextId: string | null;
  targetDisplayName?: string | null;
  targetBundlePath?: string | null;
  targetBinding?: TargetBindingState;
  timestampMs: number;
}

export interface TargetBindingEvent {
  targetContextId: string;
  binding: Exclude<TargetBindingState, "none">;
  reason: TargetBindingInvalidReason;
  timestampMs: number;
}

export type CapturePhase = "idle" | "starting" | "active" | "stopping" | "error";
export type CaptureMode = "fn-hold" | "fn-continuous" | "manual" | null;

export interface CaptureState {
  sessionId: number;
  revision: number;
  phase: CapturePhase;
  mode: CaptureMode;
  targetMode: CaptureTargetMode | null;
  targetBundleId: string | null;
  targetContextId: string | null;
  targetDisplayName: string | null;
  targetIconDataUrl: string | null;
  targetBinding: TargetBindingState;
  targetBindingReason: TargetBindingInvalidReason;
  error: string | null;
}

export type CaptureRequest = "start" | "stop";

export interface CaptureLifecycleEvent {
  sessionId: number;
  status: "starting" | "active" | "stopping" | "stopped" | "error";
  error?: string;
}

export interface CommandLogEntry {
  id: string;
  commandId: string;
  createdAt: number;
  status: "executed" | "blocked" | "cooldown" | "failed";
}

export interface VoiceSnapshot {
  phase: VoicePhase;
  auth: AuthState;
  accessibility: AccessibilityState;
  microphonePermission: MicrophonePermissionState;
  endpoint: string;
  sessionStartedAt: number | null;
  utteranceCount: number;
  reconnectCount: number;
  deliveryMode: TranscriptDeliveryMode | "unknown";
  activeTargetBundleId: string | null;
  scratchText: string;
  transcripts: TranscriptEntry[];
  commandLog: CommandLogEntry[];
  settings: AppSettings;
  error: string | null;
  helperVersion: string | null;
  fnMonitorAvailable: boolean;
  postProcessing: boolean;
  postProcessingState: PostProcessingState;
  postProcessingStartedAt: number | null;
}

export type RendererEvent =
  | { type: "snapshot"; snapshot: VoiceSnapshot }
  | { type: "notice"; message: string }
  | { type: "capture-state"; state: CaptureState }
  | { type: "navigate"; screen: ManagerScreen };

export interface StartListeningRequest {
  sampleRate: number;
  targetMode?: CaptureTargetMode;
  targetBundleId?: string;
  targetContextId?: string;
}

export interface DictationPrepareRequest extends StartListeningRequest {
  forceRefresh: boolean;
  rollover: boolean;
  reconnectMode?: "planned" | "recovery";
}

export interface DictationConnectInfo {
  websocketUrl: string;
  protocols: ["chatgpt-dictation", string, "codex-desktop"];
  sessionStart: SessionStartFrame;
}

export interface DictationPrepareResult {
  connection: DictationConnectInfo;
  snapshot: VoiceSnapshot;
}

export type DictationTransportFailureCode =
  | "connection-failed"
  | "connection-closed"
  | "session-timeout"
  | "protocol-error";

export interface AudioFrame {
  bytes: ArrayBuffer;
}

export interface SettingsPatch {
  provider?: ProviderMode;
  outputMode?: OutputMode;
  silenceDurationMs?: number;
  targetBundleIds?: string[];
  persistTranscriptHistory?: boolean;
  launchAtLogin?: boolean;
  postEditEnabled?: boolean;
  postEditModel?: PostEditModel;
  postEditReasoningEffort?: PostEditReasoningEffort;
  onboardingComplete?: boolean;
  onboardingStep?: number;
}

export interface VoiceControlApi {
  getSnapshot(): Promise<VoiceSnapshot>;
  getCaptureState(): Promise<CaptureState>;
  requestCapture(action: CaptureRequest): Promise<CaptureState>;
  reportCaptureLifecycle(event: CaptureLifecycleEvent): void;
  start(request: StartListeningRequest): Promise<VoiceSnapshot>;
  stop(): Promise<VoiceSnapshot>;
  sendAudio(bytes: ArrayBuffer): void;
  sendMicrophoneLevel(value: number): void;
  updateSettings(patch: SettingsPatch): Promise<VoiceSnapshot>;
  updateCommand(command: CommandDefinition): Promise<VoiceSnapshot>;
  requestAccessibility(): Promise<VoiceSnapshot>;
  refreshAccessibility(): Promise<VoiceSnapshot>;
  openAccessibilitySettings(): Promise<void>;
  requestMicrophonePermission(): Promise<VoiceSnapshot>;
  refreshMicrophonePermission(): Promise<VoiceSnapshot>;
  checkCodexAuth(): Promise<VoiceSnapshot>;
  showWindow(screen?: ManagerScreen): Promise<void>;
  onEvent(listener: (event: RendererEvent) => void): () => void;
}

export const DEFAULT_COMMANDS: CommandDefinition[] = [
  {
    id: "codex-send",
    label: "SEND TO CODEX",
    phrases: ["누룽지", "오케이 오픈AI 전송"],
    match: "exact-segment-or-final",
    consumeTranscript: true,
    cooldownMs: 1_000,
    targetBundleIds: ["com.openai.codex"],
    action: { type: "hotkey", key: "return", modifiers: [] },
    enabled: true,
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "codex-stream",
  outputMode: "codex",
  targetBundleIds: ["com.openai.codex"],
  silenceDurationMs: 500,
  persistTranscriptHistory: false,
  launchAtLogin: false,
  postEditEnabled: false,
  postEditModel: "gpt-5.6-luna",
  postEditReasoningEffort: "medium",
  onboardingComplete: false,
  onboardingStep: 0,
  commands: DEFAULT_COMMANDS,
};

export function createInitialSnapshot(settings: AppSettings = DEFAULT_SETTINGS): VoiceSnapshot {
  return {
    phase: "disabled",
    auth: "idle",
    accessibility: "unknown",
    microphonePermission: "unknown",
    endpoint: "chatgpt.com/backend-api/dictation/stream",
    sessionStartedAt: null,
    utteranceCount: 0,
    reconnectCount: 0,
    deliveryMode: "unknown",
    activeTargetBundleId: null,
    scratchText: "",
    transcripts: [],
    commandLog: [],
    settings,
    error: null,
    helperVersion: null,
    fnMonitorAvailable: false,
    postProcessing: false,
    postProcessingState: "idle",
    postProcessingStartedAt: null,
  };
}
