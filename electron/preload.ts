import { contextBridge, ipcRenderer } from "electron";
import type {
  CaptureLifecycleEvent,
  CaptureRequest,
  CaptureState,
  CommandDefinition,
  ManagerScreen,
  RendererEvent,
  SettingsPatch,
  StartListeningRequest,
  VoiceControlApi,
  VoiceSnapshot,
} from "../shared/contracts.js";
import { RendererDictationTransport } from "./RendererDictationTransport.js";

const dictationTransport = new RendererDictationTransport();

const api: VoiceControlApi = {
  getSnapshot: () => ipcRenderer.invoke("voice:get-snapshot") as Promise<VoiceSnapshot>,
  getCaptureState: () =>
    ipcRenderer.invoke("voice:get-capture-state") as Promise<CaptureState>,
  requestCapture: (action: CaptureRequest) =>
    ipcRenderer.invoke("voice:request-capture", action) as Promise<CaptureState>,
  reportCaptureLifecycle: (event: CaptureLifecycleEvent) =>
    ipcRenderer.send("voice:capture-lifecycle", event),
  start: (request: StartListeningRequest) => dictationTransport.start(request),
  stop: () => dictationTransport.stop(),
  sendAudio: (bytes: ArrayBuffer) => dictationTransport.sendAudio(bytes),
  sendMicrophoneLevel: (value: number) => ipcRenderer.send("voice:microphone-level", value),
  updateSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke("voice:update-settings", patch) as Promise<VoiceSnapshot>,
  updateCommand: (command: CommandDefinition) =>
    ipcRenderer.invoke("voice:update-command", command) as Promise<VoiceSnapshot>,
  requestAccessibility: () =>
    ipcRenderer.invoke("voice:request-accessibility") as Promise<VoiceSnapshot>,
  refreshAccessibility: () =>
    ipcRenderer.invoke("voice:refresh-accessibility") as Promise<VoiceSnapshot>,
  openAccessibilitySettings: () =>
    ipcRenderer.invoke("voice:open-accessibility-settings") as Promise<void>,
  requestMicrophonePermission: () =>
    ipcRenderer.invoke("voice:request-microphone") as Promise<VoiceSnapshot>,
  refreshMicrophonePermission: () =>
    ipcRenderer.invoke("voice:refresh-microphone") as Promise<VoiceSnapshot>,
  checkCodexAuth: () => ipcRenderer.invoke("voice:check-auth") as Promise<VoiceSnapshot>,
  showWindow: (screen?: ManagerScreen) =>
    ipcRenderer.invoke("voice:show-window", screen) as Promise<void>,
  onEvent: (listener: (event: RendererEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RendererEvent) => listener(payload);
    ipcRenderer.on("voice:event", wrapped);
    return () => ipcRenderer.removeListener("voice:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("voiceControl", api);

window.addEventListener("beforeunload", () => dictationTransport.dispose());
