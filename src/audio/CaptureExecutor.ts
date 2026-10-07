import type { CaptureLifecycleEvent, CaptureState } from "@shared/contracts";
import type { CaptureMicrophone } from "./MicrophoneCapture";

export class CaptureExecutor {
  private revision = -1;
  private startedSession = 0;
  private stoppedSession = 0;

  constructor(
    private readonly microphone: CaptureMicrophone,
    private readonly report: (event: CaptureLifecycleEvent) => void,
  ) {}

  accept(state: CaptureState): void {
    if (state.sessionId === 0 || state.revision <= this.revision) return;
    this.revision = state.revision;
    const sessionId = state.sessionId;
    const reportError = (error: unknown) => {
      if (this.startedSession !== sessionId || this.stoppedSession >= sessionId) return;
      this.report({ sessionId, status: "error", error: error instanceof Error ? error.message : "Voice capture failed." });
    };

    if (state.phase === "starting" && sessionId > this.startedSession) {
      this.startedSession = sessionId;
      this.report({ sessionId, status: "starting" });
      void this.microphone.start({
        targetBundleId: state.targetBundleId ?? undefined,
        targetContextId: state.targetContextId ?? undefined,
        targetMode: state.targetMode ?? "configured",
      }, () => {
        if (this.startedSession === sessionId && this.stoppedSession < sessionId) {
          this.report({ sessionId, status: "active" });
        }
      }).catch(reportError);
    } else if (state.phase === "stopping" && sessionId > this.stoppedSession) {
      this.stoppedSession = sessionId;
      this.report({ sessionId, status: "stopping" });
      void this.microphone.stop().then(() => {
        this.report({ sessionId, status: "stopped" });
      }).catch((error: unknown) => {
        this.report({ sessionId, status: "error", error: error instanceof Error ? error.message : "Voice capture failed." });
      });
    }
  }
}
