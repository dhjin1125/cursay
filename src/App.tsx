import { NodeoffBusiness } from "./NodeoffBusiness";
import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  POST_EDIT_MODELS,
  POST_EDIT_REASONING_EFFORTS,
} from "@shared/contracts";
import type {
  CaptureState,
  CaptureTargetMode,
  CommandDefinition,
  ManagerScreen,
  TranscriptEntry,
  VoiceSnapshot,
} from "@shared/contracts";
import { useMicrophoneBridge } from "./audio/useMicrophoneBridge";
import { formatError, getVoiceApi } from "./api";
import { useCaptureExecutor } from "./hooks/useCaptureExecutor";
import { useCaptureState } from "./hooks/useCaptureState";
import { useVoiceSnapshot } from "./hooks/useVoiceSnapshot";
import { Onboarding } from "./Onboarding";

const surface = new URLSearchParams(window.location.search).get("surface") === "popover"
  ? "popover"
  : "manager";

document.documentElement.dataset.surface = surface;

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-symbol"
      width={size}
      height={Math.round(size * 0.58)}
      viewBox="0 0 48 28"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 15h5l3-7 5 14 5-17 5 20 5-14 4 8h6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M43 5v19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function LineIcon({ name }: { name: "follow" | "pin" | "history" | "settings" | "copy" | "search" | "general" | "commands" | "privacy" }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (name === "follow") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M3 13c2.2-4.7 4.4-4.7 6.5 0s4.3 4.7 6.5 0c1.5-3.2 3-4.2 5-2.2" /><path {...common} d="m18 7 3.2 3.7-4.6.8" /></svg>;
  }
  if (name === "pin") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m9 3 6 2-.8 4 3.3 3.3-4.9 1.1L10 19l-1-5.6-4.7-2.1L8.2 8z" /><path {...common} d="m10 19-2 3" /></svg>;
  }
  if (name === "history") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 7v5h5" /><path {...common} d="M5.3 17a8 8 0 1 0-.8-9" /><path {...common} d="M12 8v4l2.8 1.8" /></svg>;
  }
  if (name === "settings") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>;
  }
  if (name === "copy") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...common} x="8" y="8" width="11" height="11" rx="2" /><path {...common} d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
  }
  if (name === "search") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="10.5" cy="10.5" r="6.5" /><path {...common} d="m15.5 15.5 5 5" /></svg>;
  }
  if (name === "general") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 7h16M4 17h16" /><circle {...common} cx="9" cy="7" r="2" /><circle {...common} cx="15" cy="17" r="2" /></svg>;
  }
  if (name === "commands") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M8 4 4 8l4 4M16 12l4 4-4 4M14 3l-4 18" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6z" /><path {...common} d="m9 12 2 2 4-5" /></svg>;
}

function Keycap({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

function StatusDot({ good = false, active = false }: { good?: boolean; active?: boolean }) {
  return <span className={`status-dot${good ? " is-good" : ""}${active ? " is-active" : ""}`} />;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function captureIsRunning(capture: CaptureState): boolean {
  return capture.phase === "starting" || capture.phase === "active" || capture.phase === "stopping";
}

function modeLabel(mode?: CaptureTargetMode | null): string {
  if (mode === "pinned") return "Pin";
  if (mode === "live") return "Follow";
  return "Manual";
}

function ModeRow({
  mode,
  title,
  detail,
  shortcut,
  active,
}: {
  mode: "follow" | "pin";
  title: string;
  detail: string;
  shortcut: ReactNode;
  active?: boolean;
}) {
  return (
    <div className={`mode-row${active ? " is-active" : ""}`}>
      <span className="mode-icon"><LineIcon name={mode} /></span>
      <span className="mode-copy"><strong>{title}</strong><small>{detail}</small></span>
      <Keycap>{shortcut}</Keycap>
    </div>
  );
}

function PopoverApp() {
  const [snapshot] = useVoiceSnapshot();
  const capture = useCaptureState();
  const [notice, setNotice] = useState<string | null>(null);
  const running = captureIsRunning(capture);
  const latest = snapshot.transcripts.find((entry) => entry.text.trim().length > 0);

  const stateCopy = capture.phase === "error"
    ? { label: "Needs attention", headline: "Something interrupted Cursay." }
    : snapshot.postProcessing
      ? { label: "Refining", headline: "Polishing your words." }
      : capture.phase === "starting"
        ? { label: "Starting", headline: "Getting ready to listen." }
        : capture.phase === "stopping"
          ? { label: "Finishing", headline: "Finishing this thought." }
          : capture.phase === "active" && capture.targetMode === "pinned"
            ? { label: "Listening", headline: "Pinned and listening." }
            : capture.phase === "active"
              ? { label: "Listening", headline: "Following your cursor." }
              : { label: "Ready", headline: "Ready when you are." };

  async function stopCapture() {
    setNotice(null);
    try {
      await getVoiceApi().requestCapture("stop");
    } catch (error) {
      setNotice(formatError(error));
    }
  }

  if (!snapshot.settings.onboardingComplete) {
    return (
      <main className="popover-shell popover-setup">
        <header className="popover-header">
          <div className="compact-brand"><BrandMark /><strong>Cursay</strong></div>
        </header>
        <section>
          <span className="popover-kicker">FIRST RUN</span>
          <h1>Let’s get you ready.</h1>
          <p>마이크, 손쉬운 사용 도우미, Codex 연결을 순서대로 확인합니다.</p>
        </section>
        <button className="primary-action" onClick={() => void getVoiceApi().showWindow("settings")}>Continue setup</button>
      </main>
    );
  }

  return (
    <main className="popover-shell">
      <header className="popover-header">
        <div className="compact-brand"><BrandMark /><strong>Cursay</strong></div>
        <div className="compact-status"><StatusDot good={!capture.error} active={running} /><span>{stateCopy.label}</span></div>
      </header>

      <section className="popover-state" aria-live="polite">
        <h1>{stateCopy.headline}</h1>
        {running && <button className="stop-capture" onClick={() => void stopCapture()}>Stop</button>}
      </section>

      <section className="mode-list" aria-label="Voice input shortcuts">
        <ModeRow
          mode="follow"
          title="Follow"
          detail="Current cursor"
          shortcut="Fn"
          active={running && capture.targetMode === "live"}
        />
        <ModeRow
          mode="pin"
          title="Pin"
          detail="Pinned field"
          shortcut={<>Control <span>+</span> Fn</>}
          active={running && capture.targetMode === "pinned"}
        />
      </section>

      <section className="latest-block">
        <span className="section-caption">Latest</span>
        {latest ? (
          <div className="latest-entry">
            <p>{latest.text}</p>
            <time>{formatTime(latest.createdAt)}</time>
          </div>
        ) : (
          <div className="latest-empty">Your latest words will appear here.</div>
        )}
      </section>

      {notice && <p className="popover-notice">{notice}</p>}

      <footer className="popover-footer">
        <button onClick={() => void getVoiceApi().showWindow("history")}><LineIcon name="history" />History</button>
        <button onClick={() => void getVoiceApi().showWindow("settings")}><LineIcon name="settings" />Settings</button>
      </footer>
    </main>
  );
}

function ManagerTopbar({ screen, setScreen }: { screen: ManagerScreen; setScreen: (screen: ManagerScreen) => void }) {
  return (
    <header className="manager-topbar">
      <div className="topbar-brand"><BrandMark size={24} /><strong>Cursay</strong></div>
      <nav aria-label="Main navigation">
        {(["history", "commands", "settings"] as ManagerScreen[]).map((item) => (
          <button key={item} className={screen === item ? "active" : ""} onClick={() => setScreen(item)}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
    </header>
  );
}

function HistoryView({ snapshot }: { snapshot: VoiceSnapshot }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const entries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return snapshot.transcripts.filter((entry) => {
      const display = entry.text || entry.commandId || "";
      return !normalized || display.toLocaleLowerCase().includes(normalized);
    });
  }, [query, snapshot.transcripts]);

  async function copyEntry(entry: TranscriptEntry) {
    if (!entry.text) return;
    await navigator.clipboard.writeText(entry.text);
    setCopied(entry.id);
    window.setTimeout(() => setCopied((current) => current === entry.id ? null : current), 1_200);
  }

  return (
    <section className="manager-page history-page">
      <div className="page-heading history-heading">
        <div><span className="page-kicker">RECENT DICTATION</span><h1>What you said.</h1></div>
        <label className="search-field"><LineIcon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" /></label>
      </div>

      <div className="history-section-head"><span>Today</span><small>{entries.length} entries · kept in memory</small></div>
      {entries.length === 0 ? (
        <div className="editorial-empty"><BrandMark size={38} /><h2>No words here yet.</h2><p>Use Fn for Follow or Control + Fn for Pin.</p></div>
      ) : (
        <div className="history-list">
          {entries.map((entry) => {
            const isExpanded = expanded === entry.id;
            const label = entry.text || `Command: ${entry.commandId ?? "executed"}`;
            return (
              <article className={`history-row${isExpanded ? " is-expanded" : ""}`} key={entry.id}>
                <button className="history-main" onClick={() => setExpanded(isExpanded ? null : entry.id)}>
                  <StatusDot good={entry.route !== "blocked"} />
                  <span className="history-text">{label}</span>
                  <time>{formatTime(entry.createdAt)}</time>
                  <Keycap>{entry.targetMode === "pinned" ? "⌃ Fn" : "Fn"}</Keycap>
                  <span className="history-mode">{modeLabel(entry.targetMode)}</span>
                </button>
                <button className="copy-button" disabled={!entry.text} onClick={() => void copyEntry(entry)} aria-label="Copy transcript"><LineIcon name="copy" />{copied === entry.id ? "Copied" : "Copy"}</button>
                {isExpanded && (
                  <div className="history-detail">
                    <p>{label}</p>
                    <span>{entry.stage === "final" ? "Final transcript" : "Live segment"} · {entry.route}</span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Toggle({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return <button type="button" className={`toggle${checked ? " is-on" : ""}`} onClick={onClick} aria-label={label} aria-pressed={checked}><span /></button>;
}

function CommandEditor({ command, setSnapshot }: { command: CommandDefinition; setSnapshot: (snapshot: VoiceSnapshot) => void }) {
  const [phraseText, setPhraseText] = useState(command.phrases.join(" / "));
  const [expanded, setExpanded] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => setPhraseText(command.phrases.join(" / ")), [command.phrases]);

  async function save(patch: Partial<CommandDefinition> = {}) {
    const phrases = phraseText.split("/").map((item) => item.trim()).filter(Boolean);
    const next = { ...command, ...patch, phrases: phrases.length ? phrases : command.phrases };
    setSnapshot(await getVoiceApi().updateCommand(next));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1_200);
  }

  return (
    <article className={`command-editor${expanded ? " is-expanded" : ""}`}>
      <header>
        <button className="command-disclosure" onClick={() => setExpanded(!expanded)}>
          <span>Press {command.action.key}</span><small>{expanded ? "Hide details" : command.phrases.join(" · ")}</small>
        </button>
        <Toggle checked={command.enabled} onClick={() => void save({ enabled: !command.enabled })} label={`Toggle ${command.label}`} />
      </header>
      {expanded && (
        <div className="command-body">
          <label><span>When I say</span><input value={phraseText} onChange={(event) => setPhraseText(event.target.value)} /></label>
          <div className="command-action-row"><span>Cursay will</span><Keycap>Return</Keycap></div>
          <div className="command-rule"><span>Exact phrases only</span><small>Longer sentences will never trigger this command.</small></div>
          <button className="quiet-save" onClick={() => void save()}>{saved ? "Saved" : "Save command"}</button>
        </div>
      )}
    </article>
  );
}

function CommandsView({ snapshot, setSnapshot }: { snapshot: VoiceSnapshot; setSnapshot: (snapshot: VoiceSnapshot) => void }) {
  async function addCommand() {
    const command: CommandDefinition = {
      id: `return-${Date.now()}`,
      label: "PRESS RETURN",
      phrases: ["new phrase"],
      match: "exact-segment-or-final",
      consumeTranscript: true,
      cooldownMs: 1_000,
      targetBundleIds: snapshot.settings.targetBundleIds,
      action: { type: "hotkey", key: "return", modifiers: [] },
      enabled: false,
    };
    setSnapshot(await getVoiceApi().updateCommand(command));
  }

  return (
    <section className="manager-page commands-page">
      <div className="page-heading split-heading">
        <div><span className="page-kicker">EXACT VOICE COMMANDS</span><h1>Say this. Do that.</h1></div>
        <button className="secondary-action" onClick={() => void addCommand()}>New command</button>
      </div>
      <div className="command-list">
        {snapshot.settings.commands.map((command) => <CommandEditor key={command.id} command={command} setSnapshot={setSnapshot} />)}
      </div>
      <p className="page-footnote">Commands run only when a complete live segment or final transcript matches exactly.</p>
    </section>
  );
}

type SettingsSection = "general" | "shortcuts" | "commands" | "privacy";

function PermissionRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div className="permission-row"><span>{label}</span><strong><StatusDot good={good} />{value}</strong></div>;
}

function SettingsView({
  snapshot,
  setSnapshot,
  navigate,
}: {
  snapshot: VoiceSnapshot;
  setSnapshot: (snapshot: VoiceSnapshot) => void;
  navigate: (screen: ManagerScreen) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("shortcuts");
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<VoiceSnapshot>) {
    setNotice(null);
    try {
      setSnapshot(await action());
    } catch (error) {
      setNotice(formatError(error));
    }
  }

  const navItems: Array<{ id: SettingsSection; label: string; icon: "general" | "follow" | "commands" | "privacy" }> = [
    { id: "general", label: "General", icon: "general" },
    { id: "shortcuts", label: "Shortcuts", icon: "follow" },
    { id: "commands", label: "Commands", icon: "commands" },
    { id: "privacy", label: "Privacy", icon: "privacy" },
  ];

  return (
    <section className="settings-layout">
      <aside className="settings-sidebar">
        <div className="settings-brand"><BrandMark size={23} /><strong>Cursay</strong></div>
        <nav aria-label="Settings sections">
          {navItems.map((item) => (
            <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}><LineIcon name={item.icon} />{item.label}</button>
          ))}
        </nav>
        <small>Cursay 0.1</small>
        <NodeoffBusiness />
      </aside>

      <div className="settings-content">
        {section === "shortcuts" && (
          <div className="settings-page">
            <span className="page-kicker">VOICE INPUT</span>
            <h1>Shortcuts</h1>
            <section className="settings-card shortcut-card">
              <ModeRow mode="follow" title="Follow" detail="Type at the current cursor" shortcut="Fn" />
              <ModeRow mode="pin" title="Pin" detail="Keep one field for the session" shortcut={<>Control <span>+</span> Fn</>} />
            </section>
            <h2>Behavior</h2>
            <section className="settings-card compact-rows">
              <div><span>Tap</span><strong>Start or stop</strong></div>
              <div><span>Hold</span><strong>Push to talk</strong></div>
            </section>
            <section className="settings-card permission-summary">
              <PermissionRow label="Microphone" value={snapshot.microphonePermission === "granted" ? "Allowed" : snapshot.microphonePermission} good={snapshot.microphonePermission === "granted"} />
              <PermissionRow label="Accessibility" value={snapshot.accessibility === "trusted" ? "Allowed" : snapshot.accessibility} good={snapshot.accessibility === "trusted"} />
              <PermissionRow label="Codex" value={snapshot.auth === "ready" ? "Connected" : snapshot.auth} good={snapshot.auth === "ready"} />
            </section>
          </div>
        )}

        {section === "general" && (
          <div className="settings-page">
            <span className="page-kicker">APPLICATION</span>
            <h1>General</h1>
            <h2>Transcription</h2>
            <section className="settings-card provider-card">
              <button className="provider-choice active" onClick={() => void run(() => getVoiceApi().updateSettings({ provider: "codex-stream" }))}><span><strong>Codex Stream</strong><small>Live segment delivery</small></span><StatusDot good /></button>
              <button className="provider-choice" disabled><span><strong>Local Whisper</strong><small>Runtime and model required</small></span><small>Unavailable</small></button>
            </section>
            <h2>Utterance close</h2>
            <section className="settings-card range-setting">
              <input type="range" min="300" max="2000" step="100" value={snapshot.settings.silenceDurationMs} onChange={(event) => void run(() => getVoiceApi().updateSettings({ silenceDurationMs: Number(event.target.value) }))} />
              <Keycap>{snapshot.settings.silenceDurationMs} ms</Keycap>
            </section>
            <h2>Refine</h2>
            <section className="settings-card refine-setting">
              <div className="refine-toggle-row">
                <span><strong>Refine when you finish</strong><small>Polish the entire focused field when recording ends.</small></span>
                <Toggle checked={snapshot.settings.postEditEnabled} onClick={() => void run(() => getVoiceApi().updateSettings({ postEditEnabled: !snapshot.settings.postEditEnabled }))} label="Refine when you finish" />
              </div>
              <div className="refine-options">
                <label>
                  <span>Model</span>
                  <select
                    value={snapshot.settings.postEditModel}
                    disabled={!snapshot.settings.postEditEnabled}
                    onChange={(event) => void run(() => getVoiceApi().updateSettings({
                      postEditModel: event.target.value as VoiceSnapshot["settings"]["postEditModel"],
                    }))}
                  >
                    {POST_EDIT_MODELS.map((model) => <option key={model} value={model}>{model.replace("gpt-5.6-", "")}</option>)}
                  </select>
                </label>
                <label>
                  <span>Effort</span>
                  <select
                    value={snapshot.settings.postEditReasoningEffort}
                    disabled={!snapshot.settings.postEditEnabled}
                    onChange={(event) => void run(() => getVoiceApi().updateSettings({
                      postEditReasoningEffort: event.target.value as VoiceSnapshot["settings"]["postEditReasoningEffort"],
                    }))}
                  >
                    {POST_EDIT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                  </select>
                </label>
              </div>
            </section>
            <section className="settings-card compact-rows startup-setting">
              <div><span><strong>Launch at login</strong><small>Starts muted in the menu bar</small></span><Toggle checked={snapshot.settings.launchAtLogin} onClick={() => void run(() => getVoiceApi().updateSettings({ launchAtLogin: !snapshot.settings.launchAtLogin }))} label="Launch at login" /></div>
            </section>
          </div>
        )}

        {section === "commands" && (
          <div className="settings-page">
            <span className="page-kicker">AUTOMATION</span>
            <h1>Commands</h1>
            <section className="settings-card settings-callout">
              <LineIcon name="commands" />
              <div><strong>{snapshot.settings.commands.length} configured</strong><p>Manage exact spoken phrases and the keys they send.</p></div>
              <button className="secondary-action" onClick={() => navigate("commands")}>Open commands</button>
            </section>
          </div>
        )}

        {section === "privacy" && (
          <div className="settings-page">
            <span className="page-kicker">LOCAL PERMISSIONS</span>
            <h1>Privacy</h1>
            <section className="settings-card privacy-card">
              <PermissionRow label="Microphone" value={snapshot.microphonePermission === "granted" ? "Allowed" : snapshot.microphonePermission} good={snapshot.microphonePermission === "granted"} />
              <div className="permission-actions"><button onClick={() => void run(() => getVoiceApi().requestMicrophonePermission())}>Request microphone</button><button onClick={() => void run(() => getVoiceApi().refreshMicrophonePermission())}>Refresh</button></div>
              <PermissionRow label="Accessibility helper" value={snapshot.accessibility === "trusted" ? "Allowed" : snapshot.accessibility} good={snapshot.accessibility === "trusted" && snapshot.fnMonitorAvailable} />
              <div className="permission-actions"><button onClick={() => void run(() => getVoiceApi().requestAccessibility())}>Request access</button><button onClick={() => void getVoiceApi().openAccessibilitySettings()}>System Settings</button><button onClick={() => void run(() => getVoiceApi().refreshAccessibility())}>Refresh</button></div>
              <PermissionRow label="Codex session" value={snapshot.auth === "ready" ? "Connected" : snapshot.auth} good={snapshot.auth === "ready"} />
              <div className="permission-actions"><button onClick={() => void run(() => getVoiceApi().checkCodexAuth())}>Check connection</button></div>
            </section>
            <p className="privacy-note">권한 요청은 버튼을 눌렀을 때만 실행됩니다. Input Monitoring 권한은 사용하지 않습니다.</p>
            <button className="text-action" onClick={() => void run(() => getVoiceApi().updateSettings({ onboardingComplete: false, onboardingStep: 0 }))}>Run onboarding again</button>
          </div>
        )}
        {notice && <div className="settings-notice">{notice}</div>}
      </div>
    </section>
  );
}

function ManagerApp() {
  const [screen, setScreen] = useState<ManagerScreen>("history");
  const [snapshot, setSnapshot] = useVoiceSnapshot();
  const microphone = useMicrophoneBridge();
  useCaptureExecutor(microphone);

  useEffect(() => getVoiceApi().onEvent((event) => {
    if (event.type === "navigate") setScreen(event.screen);
  }), []);

  if (!snapshot.settings.onboardingComplete) {
    return <Onboarding snapshot={snapshot} setSnapshot={setSnapshot} />;
  }

  return (
    <main className="manager-shell">
      <ManagerTopbar screen={screen} setScreen={setScreen} />
      {screen === "history" && <HistoryView snapshot={snapshot} />}
      {screen === "commands" && <CommandsView snapshot={snapshot} setSnapshot={setSnapshot} />}
      {screen === "settings" && <SettingsView snapshot={snapshot} setSnapshot={setSnapshot} navigate={setScreen} />}
    </main>
  );
}

export default function App() {
  return surface === "popover" ? <PopoverApp /> : <ManagerApp />;
}
