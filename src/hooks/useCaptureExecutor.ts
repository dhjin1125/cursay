import { useEffect } from "react";
import { CaptureExecutor } from "../audio/CaptureExecutor";
import type { MicrophoneBridge } from "../audio/useMicrophoneBridge";
import { getVoiceApi } from "../api";

export function useCaptureExecutor(microphone: MicrophoneBridge): void {
  useEffect(() => {
    const api = getVoiceApi();
    const executor = new CaptureExecutor(microphone, api.reportCaptureLifecycle);
    let live = true;
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "capture-state") executor.accept(event.state);
    });
    void api.getCaptureState().then((state) => {
      if (live) executor.accept(state);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [microphone.start, microphone.stop]);
}
