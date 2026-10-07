import { useEffect, useState } from "react";
import { createInitialCaptureState } from "@shared/capture-state";
import type { CaptureState } from "@shared/contracts";
import { getVoiceApi } from "../api";

export function useCaptureState(): CaptureState {
  const [state, setState] = useState<CaptureState>(() => createInitialCaptureState());

  useEffect(() => {
    let live = true;
    const unsubscribe = getVoiceApi().onEvent((event) => {
      if (event.type === "capture-state") {
        setState((current) => event.state.revision >= current.revision ? event.state : current);
      }
    });
    void getVoiceApi().getCaptureState().then((next) => {
      if (live) setState((current) => next.revision >= current.revision ? next : current);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return state;
}
