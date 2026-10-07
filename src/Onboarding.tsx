import { useState, type ReactNode } from "react";
import type { VoiceSnapshot } from "@shared/contracts";
import { formatError, getVoiceApi } from "./api";

interface OnboardingProps {
  snapshot: VoiceSnapshot;
  setSnapshot(snapshot: VoiceSnapshot): void;
}

const steps = ["Welcome", "Microphone", "Accessibility", "Codex", "Ready"];

function OnboardingMark() {
  return (
    <svg width="26" height="16" viewBox="0 0 48 28" fill="none" aria-hidden="true">
      <path d="M2 15h5l3-7 5 14 5-17 5 20 5-14 4 8h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M43 5v19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function SetupStatus({ label, ready }: { label: string; ready: boolean }) {
  return <span className={ready ? "is-ready" : ""}><i />{label}</span>;
}

function ShortcutCard({
  kind,
  title,
  description,
  shortcut,
}: {
  kind: "follow" | "pin";
  title: string;
  description: string;
  shortcut: ReactNode;
}) {
  return (
    <div className="onboarding-shortcut">
      <div className={`shortcut-illustration ${kind}`}>
        <span className="field-outline" />
        <span className="field-caret" />
        <span className="motion-line line-one" />
        <span className="motion-line line-two" />
        <span className="motion-line line-three" />
      </div>
      <div><strong>{title}</strong><p>{description}</p></div>
      <kbd>{shortcut}</kbd>
    </div>
  );
}

export function Onboarding({ snapshot, setSnapshot }: OnboardingProps) {
  const step = Math.min(4, Math.max(0, snapshot.settings.onboardingStep));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const microphoneReady = snapshot.microphonePermission === "granted";
  const accessibilityReady = snapshot.accessibility === "trusted" && snapshot.fnMonitorAvailable;
  const codexReady = snapshot.auth === "ready";

  async function run(action: () => Promise<VoiceSnapshot>) {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await action());
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(false);
    }
  }

  function goTo(nextStep: number) {
    void run(() => getVoiceApi().updateSettings({ onboardingStep: nextStep }));
  }

  function finish() {
    void run(() => getVoiceApi().updateSettings({ onboardingComplete: true, onboardingStep: 4 }));
  }

  return (
    <main className="onboarding-shell">
      <header className="onboarding-topbar">
        <div className="onboarding-brand"><OnboardingMark /><strong>Cursay</strong></div>
        <ol aria-label="Setup progress">
          {steps.map((label, index) => <li key={label} className={index === step ? "active" : index < step ? "done" : ""}><span>{label}</span></li>)}
        </ol>
      </header>

      <section className="onboarding-stage">
        {step === 0 && (
          <div className="onboarding-welcome">
            <div className="welcome-copy">
              <span className="onboarding-kicker">VOICE INPUT, WHEREVER YOU TYPE</span>
              <h1>Say it.<br />It lands.</h1>
              <p>Cursay writes wherever your cursor is, or keeps one field pinned while you move between applications.</p>
            </div>
            <div className="shortcut-explainer">
              <ShortcutCard kind="follow" title="Follow" description="Moves with your cursor" shortcut="Fn" />
              <ShortcutCard kind="pin" title="Pin" description="Stays in one field" shortcut={<>Control <span>+</span> Fn</>} />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-permission-page">
            <span className="onboarding-kicker">STEP 1 · AUDIO INPUT</span>
            <h1>Let Cursay hear you.</h1>
            <p>마이크 권한만 요청합니다. 이 단계에서 녹음, 전송, 재생은 시작하지 않습니다.</p>
            <div className={`permission-panel${microphoneReady ? " is-ready" : ""}`}>
              <div><span>Microphone</span><strong>{microphoneReady ? "Allowed" : snapshot.microphonePermission}</strong></div>
              <button disabled={busy || microphoneReady} onClick={() => void run(() => getVoiceApi().requestMicrophonePermission())}>{microphoneReady ? "Ready" : "Request microphone"}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-permission-page">
            <span className="onboarding-kicker">STEP 2 · TEXT DELIVERY</span>
            <h1>Let Cursay type.</h1>
            <p>손쉬운 사용 도우미가 Fn 단축키를 받고 선택한 입력 위치로 텍스트를 전달합니다. Input Monitoring 권한은 사용하지 않습니다.</p>
            <div className={`permission-panel${accessibilityReady ? " is-ready" : ""}`}>
              <div><span>Accessibility helper</span><strong>{accessibilityReady ? "Allowed" : snapshot.accessibility}</strong></div>
              <button disabled={busy || accessibilityReady} onClick={() => void run(() => getVoiceApi().requestAccessibility())}>{accessibilityReady ? "Ready" : "Request access"}</button>
            </div>
            <div className="inline-actions">
              <button onClick={() => void getVoiceApi().openAccessibilitySettings()}>Open System Settings</button>
              <button disabled={busy} onClick={() => void run(() => getVoiceApi().refreshAccessibility())}>Refresh status</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-permission-page">
            <span className="onboarding-kicker">STEP 3 · TRANSCRIPTION</span>
            <h1>Connect Codex.</h1>
            <p>기존 Codex 로그인을 확인합니다. 인증 정보는 화면이나 설정 파일에 저장하지 않습니다.</p>
            <div className={`permission-panel${codexReady ? " is-ready" : ""}`}>
              <div><span>Codex session</span><strong>{codexReady ? "Connected" : snapshot.auth}</strong></div>
              <button disabled={busy || codexReady} onClick={() => void run(() => getVoiceApi().checkCodexAuth())}>{codexReady ? "Ready" : "Check connection"}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboarding-ready-page">
            <OnboardingMark />
            <span className="onboarding-kicker">SETUP COMPLETE</span>
            <h1>Ready when you are.</h1>
            <p><kbd>Fn</kbd> follows the current cursor. <kbd>Control + Fn</kbd> keeps the starting field pinned.</p>
          </div>
        )}
      </section>

      <footer className="onboarding-footer">
        <div className="setup-statuses">
          <SetupStatus label="Microphone" ready={microphoneReady} />
          <SetupStatus label="Accessibility" ready={accessibilityReady} />
          <SetupStatus label="Codex" ready={codexReady} />
        </div>
        <div className="onboarding-nav">
          {step > 0 && step < 4 && <button className="back-button" disabled={busy} onClick={() => goTo(step - 1)}>Back</button>}
          {step === 0 && <button className="continue-button" disabled={busy} onClick={() => goTo(1)}>Continue</button>}
          {step === 1 && <button className="continue-button" disabled={busy || !microphoneReady} onClick={() => goTo(2)}>Continue</button>}
          {step === 2 && <button className="continue-button" disabled={busy || !accessibilityReady} onClick={() => goTo(3)}>Continue</button>}
          {step === 3 && <button className="continue-button" disabled={busy || !codexReady} onClick={() => goTo(4)}>Continue</button>}
          {step === 4 && <button className="continue-button" disabled={busy} onClick={finish}>Open Cursay</button>}
        </div>
      </footer>
      {error && <div className="onboarding-error">{error}</div>}
    </main>
  );
}
