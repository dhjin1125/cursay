import { useCallback, useEffect, useRef, useState } from "react";
import { formatError, getVoiceApi, isElectronRuntime } from "../api";
import { MicrophoneCapture, type CaptureMicrophone, type MicrophoneRequest } from "./MicrophoneCapture";

export interface MicrophoneBridge extends CaptureMicrophone {
  level: number;
  error: string | null;
}

export function useMicrophoneBridge(): MicrophoneBridge {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const captureRef = useRef<MicrophoneCapture | null>(null);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    const capture = new MicrophoneCapture(getVoiceApi(), setLevel);
    captureRef.current = capture;
    void capture.prepare().catch(() => undefined);
    return () => {
      captureRef.current = null;
      capture.dispose();
    };
  }, []);

  const start = useCallback(async (request: MicrophoneRequest, onRecording: () => void) => {
    setError(null);
    try {
      if (!captureRef.current) {
        throw new Error("Microphone capture is available only inside the desktop app.");
      }
      await captureRef.current.start(request, onRecording);
    } catch (cause) {
      const message = formatError(cause);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const stop = useCallback(async () => {
    setError(null);
    try {
      return captureRef.current ? await captureRef.current.stop() : await getVoiceApi().stop();
    } catch (cause) {
      const message = formatError(cause);
      setError(message);
      throw new Error(message);
    }
  }, []);

  return { level, error, start, stop };
}
