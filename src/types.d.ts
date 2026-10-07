import type { VoiceControlApi } from "../shared/contracts";

declare global {
  interface Window {
    voiceControl?: VoiceControlApi;
  }
}

export {};
