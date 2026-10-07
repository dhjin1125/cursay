import { useEffect, useState } from "react";
import { createInitialSnapshot, type VoiceSnapshot } from "@shared/contracts";
import { getVoiceApi } from "../api";

export function useVoiceSnapshot(): [VoiceSnapshot, (snapshot: VoiceSnapshot) => void] {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(() => createInitialSnapshot());

  useEffect(() => {
    let live = true;
    void getVoiceApi().getSnapshot().then((next) => {
      if (live) setSnapshot(next);
    });
    const unsubscribe = getVoiceApi().onEvent((event) => {
      if (event.type === "snapshot") setSnapshot(event.snapshot);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return [snapshot, setSnapshot];
}
