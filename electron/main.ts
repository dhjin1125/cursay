import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import type {
  CaptureLifecycleEvent,
  CaptureRequest,
  CaptureState,
  CommandDefinition,
  DictationPrepareRequest,
  DictationTransportFailureCode,
  ManagerScreen,
  SettingsPatch,
  VoiceSnapshot,
  MicrophonePermissionState,
  PushToTalkEvent,
  TargetBindingEvent,
} from "../shared/contracts.js";
import { ActionBridge } from "./services/ActionBridge.js";
import { CodexAuthBroker } from "./services/CodexAuthBroker.js";
import { SettingsStore } from "./services/SettingsStore.js";
import { VoiceController } from "./services/VoiceController.js";
import { LoginLaunchAgent } from "./services/LoginLaunchAgent.js";
import { CaptureCoordinator } from "./services/CaptureCoordinator.js";
import {
  getTargetIconCacheKey,
  getTargetIconCandidates,
} from "./services/TargetIconResolver.js";

let mainWindow: BrowserWindow | null = null;
let popoverWindow: BrowserWindow | null = null;
let pushToTalkOverlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: VoiceController | null = null;
let actionBridge: ActionBridge | null = null;
let loginLaunchAgent: LoginLaunchAgent | null = null;
let quitting = false;
const captureCoordinator = new CaptureCoordinator();
const captureTargetContexts = new Map<number, string>();
let pushToTalkOperation: Promise<void> = Promise.resolve();
const targetIconCache = new Map<string, Promise<string | null>>();
let overlayHideTimer: NodeJS.Timeout | null = null;
let overlayMicrophoneLevel = 0;
let preparedFinishSessionId: number | null = null;

const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}body{display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
.pill{display:flex;width:262px;height:34px;align-items:center;gap:9px;padding:0 9px;color:#f7f1e8;border:1px solid rgba(255,255,255,.16);border-radius:9px;background:rgba(32,30,26,.96);box-shadow:0 8px 24px rgba(32,26,20,.25);backdrop-filter:blur(16px);transform:translateZ(0)}
.target{display:none;width:18px;height:18px;flex:0 0 18px;align-items:center;justify-content:center}.is-pinned .target{display:flex}.target img,.target-fallback{width:18px;height:18px;border-radius:4px}.target img{object-fit:contain}.target img:not([src]){display:none}.target img[src]+.target-fallback{display:none}.target-fallback{display:grid;place-items:center;background:rgba(255,255,255,.14);font-size:8px;font-weight:700}
.wave{display:flex;width:36px;height:17px;flex:0 0 36px;align-items:center;gap:2px;padding-right:7px;border-right:1px solid rgba(255,255,255,.15)}.bar{width:2px;height:2px;flex:0 0 2px;border-radius:2px;background:#e76452;opacity:.72;transition:height 50ms linear,opacity 80ms linear}
.copy{display:flex;min-width:0;flex:1;align-items:baseline;gap:5px;white-space:nowrap}.mode{font-size:9px;font-weight:650}.detail{overflow:hidden;color:rgba(247,241,232,.58);font-size:8px;text-overflow:ellipsis}.key{display:flex;height:19px;align-items:center;padding:0 6px;color:rgba(247,241,232,.75);border:1px solid rgba(255,255,255,.18);border-radius:5px;font-size:7.5px;white-space:nowrap}
.status{display:none;min-width:0;flex:1;color:#f0b8aa;font-size:8.5px;font-weight:650;white-space:nowrap}.connecting .copy,.correcting .copy,.post-timeout .copy,.post-failed .copy,.post-success .copy,.processing .copy,.error .copy,.target-invalid .copy{display:none}.connecting .status,.correcting .status,.post-timeout .status,.post-failed .status,.post-success .status,.processing .status,.error .status,.target-invalid .status{display:block}.connecting .key,.correcting .key,.post-timeout .key,.post-failed .key,.post-success .key,.processing .key,.error .key,.target-invalid .key{display:none}
.connecting .bar,.correcting .bar,.processing .bar{height:4px!important;animation:process .75s ease-in-out infinite}.connecting .bar:nth-child(2n),.correcting .bar:nth-child(2n),.processing .bar:nth-child(2n){animation-delay:.12s}.post-success .bar,.done .bar{height:4px!important;background:#75b17d}.post-timeout .bar,.post-failed .bar,.error .bar,.target-invalid .bar{height:4px!important;background:#ef8a7d}
@keyframes process{0%,100%{opacity:.35;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
</style></head><body><div id="pill" class="pill connecting target-none" role="status" aria-label="Connecting"><div class="target" aria-hidden="true"><img id="target-icon" alt=""><span id="target-fallback" class="target-fallback">•</span></div><div class="wave" aria-hidden="true"><i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i></div><div class="copy"><span id="mode" class="mode">Follow</span><span>·</span><span id="detail" class="detail">Current cursor</span></div><span id="status" class="status">Connecting…</span><span id="key" class="key">Fn</span></div>
<script>(function(){var pill=document.getElementById('pill');var icon=document.getElementById('target-icon');var fallback=document.getElementById('target-fallback');var modeLabel=document.getElementById('mode');var detail=document.getElementById('detail');var status=document.getElementById('status');var key=document.getElementById('key');var bars=Array.from(document.querySelectorAll('.bar'));var history=new Array(bars.length).fill(0);var mode='connecting';var binding='none';var noiseFloor=.015;var correctionStartedAt=0;var correctionTimer=0;var staticStatus='Connecting…';function reset(){history.fill(0);bars.forEach(function(bar){bar.style.height='2px';bar.style.opacity='.72'})}function stopClock(){if(correctionTimer)clearInterval(correctionTimer);correctionTimer=0;correctionStartedAt=0}function updateStatus(){if(mode==='correcting'&&correctionStartedAt>0){status.textContent='Refining · '+(Math.max(0,Date.now()-correctionStartedAt)/1000).toFixed(1)+'s'}else{status.textContent=staticStatus}}window.setOverlayState=function(value){var previous=mode;mode=value.mode;binding=value.binding||'none';var pinned=value.targetMode==='pinned';pill.className='pill '+mode+' target-'+binding+(pinned?' is-pinned':'');modeLabel.textContent=pinned?'Pin':'Follow';detail.textContent=pinned?(value.displayName||'Pinned field'):'Current cursor';key.textContent=pinned?'Control + Fn':'Fn';var name=value.displayName||'Pinned field';var image=typeof value.iconDataUrl==='string'&&value.iconDataUrl.indexOf('data:image/png;base64,')===0?value.iconDataUrl:'';if(image)icon.setAttribute('src',image);else icon.removeAttribute('src');fallback.textContent=Array.from(name)[0]||'•';staticStatus=value.statusText||'Working…';var startedAt=Number(value.startedAt)||0;if(mode==='correcting'&&startedAt>0){if(correctionStartedAt!==startedAt){stopClock();correctionStartedAt=startedAt;correctionTimer=setInterval(updateStatus,100)}updateStatus()}else{stopClock();updateStatus()}pill.setAttribute('aria-label',(pinned?'Pin':'Follow')+' '+mode);var wasLive=previous==='listening'||previous==='continuous';var isLive=(mode==='listening'||mode==='continuous')&&binding!=='invalid';if(isLive&&!wasLive)reset();if(!isLive)bars.forEach(function(bar){bar.style.height='';bar.style.opacity=''})};window.setOverlayLevel=function(input){if((mode!=='listening'&&mode!=='continuous')||binding==='invalid')return;var value=Math.max(0,Math.min(1,Number(input)||0));var follow=value<=noiseFloor+.025?.08:.003;noiseFloor=noiseFloor*(1-follow)+value*follow;noiseFloor=Math.max(0,Math.min(.32,noiseFloor));var voice=Math.max(0,value-noiseFloor-.012)/Math.max(.01,1-noiseFloor);voice=Math.min(1,Math.pow(voice*1.9,.65));var prior=history[history.length-1];var shaped=voice>prior?prior*.22+voice*.78:prior*.7+voice*.3;history.shift();history.push(shaped);bars.forEach(function(bar,index){var sample=history[index];bar.style.height=(2+Math.round(15*sample))+'px';bar.style.opacity=String(.72+.28*sample)})};reset()})();</script></body></html>`;


function getHelperAppPath(): string {
  const bundle = "Codex Voice Control.app";
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", bundle)
    : path.join(app.getAppPath(), "native", "build", bundle);
}

function getPackagedAppPath(): string {
  return path.resolve(path.dirname(process.execPath), "../..");
}

function getMicrophonePermission(): MicrophonePermissionState {
  if (process.platform !== "darwin") return "unknown";
  const state = systemPreferences.getMediaAccessStatus("microphone");
  return state === "not-determined" || state === "denied" || state === "restricted" || state === "granted"
    ? state
    : "unknown";
}

function broadcast(snapshot: VoiceSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("voice:event", { type: "snapshot", snapshot });
  }
  if (snapshot.phase === "error") {
    captureCoordinator.fail(snapshot.error ?? "Voice capture failed.");
  }
  const capture = captureCoordinator.getState();
  if (
    snapshot.phase === "connecting" &&
    capture.phase === "active" &&
    snapshot.sessionStartedAt !== null
  ) {
    clearOverlayHideTimer();
    renderPushToTalkOverlay({
      mode: capture.mode === "fn-continuous" ? "continuous" : "listening",
      targetMode: capture.targetMode,
      binding: capture.targetBinding,
      displayName: capture.targetDisplayName,
      iconDataUrl: capture.targetIconDataUrl,
      statusText: "RECONNECTING",
    }, capture);
  } else {
    updateCaptureOverlay(capture);
  }
  updateTray(snapshot, capture);
}

function createPushToTalkOverlay(): void {
  pushToTalkOverlay = new BrowserWindow({
    width: 262,
    height: 50,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    type: "panel",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pushToTalkOverlay.setIgnoreMouseEvents(true);
  pushToTalkOverlay.setAlwaysOnTop(true, "status");
  pushToTalkOverlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void pushToTalkOverlay.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`,
  ).then(() => updateCaptureOverlay(captureCoordinator.getState()));
}

function positionPushToTalkOverlay(): void {
  if (!pushToTalkOverlay) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width, height] = pushToTalkOverlay.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + 10);
  pushToTalkOverlay.setPosition(x, y, false);
}

function renderPushToTalkOverlay(value: {
  mode: "connecting" | "listening" | "continuous" | "correcting" | "post-timeout" | "post-failed" | "post-success" | "processing" | "done" | "error";
  targetMode?: CaptureState["targetMode"];
  binding?: CaptureState["targetBinding"];
  displayName?: string | null;
  iconDataUrl?: string | null;
  statusText?: string | null;
  startedAt?: number | null;
}, expected: CaptureState): void {
  const overlay = pushToTalkOverlay;
  if (!overlay || overlay.isDestroyed()) return;
  const render = () => {
    if (overlay.isDestroyed()) return;
    const current = captureCoordinator.getState();
    if (
      current.sessionId !== expected.sessionId ||
      current.revision !== expected.revision ||
      current.phase === "idle"
    ) {
      return;
    }
    positionPushToTalkOverlay();
    void overlay.webContents.executeJavaScript(
      `window.setOverlayState(${JSON.stringify({
        ...value,
        targetMode: value.targetMode ?? expected.targetMode,
        binding: value.binding ?? expected.targetBinding,
        displayName: value.displayName ?? expected.targetDisplayName,
        iconDataUrl: value.iconDataUrl ?? expected.targetIconDataUrl,
      })})`,
      true,
    );
    overlay.showInactive();
  };
  if (overlay.webContents.isLoadingMainFrame()) {
    overlay.webContents.once("did-finish-load", render);
  } else {
    render();
  }
}

function updatePushToTalkOverlayLevel(value: number): void {
  const capture = captureCoordinator.getState();
  if (capture.phase !== "starting" && capture.phase !== "active") return;
  overlayMicrophoneLevel = Math.max(0, Math.min(1, value));
  const overlay = pushToTalkOverlay;
  if (
    !overlay ||
    overlay.isDestroyed() ||
    !overlay.isVisible() ||
    overlay.webContents.isLoadingMainFrame()
  ) {
    return;
  }
  void overlay.webContents.executeJavaScript(
    `window.setOverlayLevel(${overlayMicrophoneLevel})`,
    true,
  );
}

function clearOverlayHideTimer(): void {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
}

function hidePushToTalkOverlayAfter(milliseconds: number, expected: CaptureState): void {
  clearOverlayHideTimer();
  overlayHideTimer = setTimeout(() => {
    const current = captureCoordinator.getState();
    if (
      current.sessionId !== expected.sessionId ||
      current.revision !== expected.revision ||
      current.phase !== expected.phase
    ) {
      overlayHideTimer = null;
      return;
    }
    pushToTalkOverlay?.hide();
    overlayHideTimer = null;
  }, milliseconds);
}

function handlePushToTalk(event: PushToTalkEvent): void {
  const run = async () => {
    if (!controller?.getSnapshot().settings.onboardingComplete) return;
    let preparedEvent = event;
    const capture = captureCoordinator.getState();
    if (
      event.state === "down" &&
      event.targetMode === "pinned" &&
      (capture.phase === "idle" || capture.phase === "error")
    ) {
      try {
        const target = await actionBridge?.captureTarget();
        const latest = captureCoordinator.getState();
        if (
          target &&
          (latest.phase === "idle" || latest.phase === "error")
        ) {
          preparedEvent = {
            ...event,
            ...target,
            targetBinding: "foreground",
          };
        } else if (target) {
          await actionBridge?.releaseTarget(target.targetContextId);
        }
      } catch {
        preparedEvent = {
          ...event,
          targetBundleId: null,
          targetContextId: null,
        };
      }
    }
    const next = captureCoordinator.handlePushToTalk(preparedEvent);
    if (
      preparedEvent.state === "down" &&
      preparedEvent.targetContextId &&
      preparedEvent.targetBundlePath &&
      next.targetContextId === preparedEvent.targetContextId
    ) {
      void loadTargetIcon(
        preparedEvent.targetBundlePath,
        preparedEvent.targetContextId,
        preparedEvent.targetBundleId,
      );
    }
  };
  const current = pushToTalkOperation.then(run, run);
  pushToTalkOperation = current.catch(() => undefined);
}

async function resolveTargetIcon(
  bundlePath: string,
  bundleId: string | null,
): Promise<string | null> {
  for (const candidate of getTargetIconCandidates(bundlePath, bundleId)) {
    const customIcon = nativeImage.createFromPath(candidate);
    if (!customIcon.isEmpty()) {
      return customIcon.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
    }
  }

  const appIcon = await app.getFileIcon(bundlePath, { size: "normal" });
  if (appIcon.isEmpty()) return null;
  return appIcon.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
}

async function loadTargetIcon(
  bundlePath: string,
  targetContextId: string,
  bundleId: string | null,
): Promise<void> {
  const cacheKey = getTargetIconCacheKey(bundlePath, bundleId);
  let pending = targetIconCache.get(cacheKey);
  if (!pending) {
    if (targetIconCache.size >= 64) {
      const oldest = targetIconCache.keys().next().value;
      if (typeof oldest === "string") targetIconCache.delete(oldest);
    }
    pending = resolveTargetIcon(bundlePath, bundleId).catch(() => null);
    targetIconCache.set(cacheKey, pending);
  }
  const dataUrl = await pending;
  if (dataUrl) captureCoordinator.setTargetIcon(targetContextId, dataUrl);
}

function handleTargetBinding(event: TargetBindingEvent): void {
  const before = captureCoordinator.getState();
  if (before.targetContextId !== event.targetContextId) return;
  const next = captureCoordinator.acceptTargetBinding(event);
  if (
    event.binding === "invalid" &&
    (next.phase === "starting" || next.phase === "active")
  ) {
    const target = next.targetDisplayName ?? next.targetBundleId ?? "입력 대상";
    const detail = event.reason === "process-terminated"
      ? `${target} 앱이 종료되어 연결이 끊겼습니다.`
      : `${target} 입력창과의 연결이 끊겼습니다.`;
    captureCoordinator.fail(detail);
  }
}

function updateCaptureOverlay(state: CaptureState): void {
  clearOverlayHideTimer();
  if (state.phase === "idle" || state.phase === "stopping") {
    overlayMicrophoneLevel = 0;
    const refinement = controller?.getSnapshot().postProcessingState;
    if (refinement === "failed" || refinement === "timed-out") {
      renderPushToTalkOverlay({
        mode: refinement === "failed" ? "post-failed" : "post-timeout",
        targetMode: state.targetMode,
        statusText: refinement === "failed" ? "REFINE FAILED" : "REFINE TIMEOUT",
      }, state);
    } else {
      pushToTalkOverlay?.hide();
    }
    return;
  }

  if (state.phase === "starting" || state.phase === "active") {
    renderPushToTalkOverlay({
      mode: state.phase === "starting"
        ? "connecting"
        : state.mode === "fn-continuous" ? "continuous" : "listening",
      targetMode: state.targetMode,
      binding: state.targetBinding,
      displayName: state.targetDisplayName,
      iconDataUrl: state.targetIconDataUrl,
      statusText: state.phase === "starting"
        ? "CONNECTING"
        : state.targetBinding === "invalid" ? "연결 끊김" : null,
    }, state);
    return;
  }

  overlayMicrophoneLevel = 0;
  renderPushToTalkOverlay({
    mode: "error",
    targetMode: state.targetMode,
    binding: state.targetBinding,
    displayName: state.targetDisplayName,
    iconDataUrl: state.targetIconDataUrl,
    statusText: "연결 끊김",
  }, state);
  hidePushToTalkOverlayAfter(3_500, state);
}

function broadcastCaptureState(state: CaptureState): void {
  if (state.phase === "stopping") {
    if (state.error) void controller?.stop();
    else if (preparedFinishSessionId !== state.sessionId) {
      preparedFinishSessionId = state.sessionId;
      controller?.prepareToFinish();
    }
  }
  if (state.targetContextId) {
    captureTargetContexts.set(state.sessionId, state.targetContextId);
  }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("voice:event", { type: "capture-state", state });
  }
  updateCaptureOverlay(state);
  if (controller) updateTray(controller.getSnapshot(), state);
}

async function releaseCaptureTarget(sessionId: number): Promise<void> {
  const targetContextId = captureTargetContexts.get(sessionId);
  if (!targetContextId) return;
  captureTargetContexts.delete(sessionId);
  try {
    await actionBridge?.releaseTarget(targetContextId);
  } catch {
    // The helper is either already gone or will discard the context on disconnect.
  }
}

async function acceptCaptureLifecycle(value: CaptureLifecycleEvent): Promise<void> {
  const current = captureCoordinator.getState();
  if (
    value.status === "stopped" ||
    (value.status === "error" &&
      value.sessionId === current.sessionId &&
      current.phase === "stopping")
  ) {
    await releaseCaptureTarget(value.sessionId);
  }
  captureCoordinator.acceptLifecycle(value);
}

function updateTray(snapshot: VoiceSnapshot, capture: CaptureState): void {
  if (!tray) return;
  tray.setTitle("");
  const target = capture.targetMode === "pinned" ? "Pin" : "Follow";
  const state = capture.phase === "idle" ? "Ready" : `${target} · ${capture.phase}`;
  tray.setToolTip(`Cursay — ${state}${snapshot.phase === "speech" ? " · speech" : ""}`);
}

function showWindow(screenName: ManagerScreen = "history"): void {
  if (!mainWindow) return;
  popoverWindow?.hide();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const sendNavigation = () => mainWindow?.webContents.send("voice:event", {
    type: "navigate",
    screen: screenName,
  });
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once("did-finish-load", sendNavigation);
  } else {
    sendNavigation();
  }
}

async function createWindow(showOnReady: boolean): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: "#fbf8f1",
    title: "Cursay",
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      // This hidden window owns microphone capture and must respond to Fn immediately.
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    const managerUrl = new URL(developmentUrl);
    managerUrl.searchParams.set("surface", "manager");
    await mainWindow.loadURL(managerUrl.toString());
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"), {
      query: { surface: "manager" },
    });
  }
  if (showOnReady) mainWindow.show();
}

function positionPopover(): void {
  if (quitting || !tray || tray.isDestroyed() || !popoverWindow || popoverWindow.isDestroyed()) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const [width, height] = popoverWindow.getSize();
  const centerX = trayBounds.x + trayBounds.width / 2;
  const preferredY = trayBounds.y + trayBounds.height + 6;
  const x = Math.round(Math.max(
    display.workArea.x + 8,
    Math.min(centerX - width / 2, display.workArea.x + display.workArea.width - width - 8),
  ));
  const y = preferredY + height <= display.workArea.y + display.workArea.height
    ? Math.round(preferredY)
    : Math.round(trayBounds.y - height - 6);
  popoverWindow.setPosition(x, y, false);
}

function showPopover(): void {
  if (quitting || !popoverWindow || popoverWindow.isDestroyed()) return;
  positionPopover();
  popoverWindow.show();
  popoverWindow.focus();
}

function togglePopover(): void {
  if (!popoverWindow) return;
  if (popoverWindow.isVisible()) popoverWindow.hide();
  else showPopover();
}

async function createPopoverWindow(): Promise<void> {
  popoverWindow = new BrowserWindow({
    width: 360,
    height: 438,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    title: "Cursay",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  popoverWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popoverWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  popoverWindow.on("blur", () => {
    if (!popoverWindow?.webContents.isDevToolsOpened()) popoverWindow?.hide();
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    const popoverUrl = new URL(developmentUrl);
    popoverUrl.searchParams.set("surface", "popover");
    await popoverWindow.loadURL(popoverUrl.toString());
  } else {
    await popoverWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"), {
      query: { surface: "popover" },
    });
  }
}

function createTrayIcon(): Electron.NativeImage {
  const iconPath = path.join(app.getAppPath(), "assets", "tray-template.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    icon.setTemplateImage(true);
    return icon;
  }
  const fallback = nativeImage.createFromNamedImage("NSActionTemplate");
  fallback.setTemplateImage(true);
  return fallback;
}

function trayMenu(): Menu {
  const capture = captureCoordinator.getState();
  return Menu.buildFromTemplate([
    { label: "Open Cursay", click: () => showWindow("history") },
    { label: "Settings…", click: () => showWindow("settings") },
    {
      label: "Stop Dictation",
      enabled: capture.phase !== "idle" && capture.phase !== "error",
      click: () => captureCoordinator.request("stop"),
    },
    { type: "separator" },
    {
      label: "Quit Cursay",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.on("click", togglePopover);
  tray.on("right-click", () => tray?.popUpContextMenu(trayMenu()));
}

function registerIpc(): void {
  ipcMain.handle("voice:get-snapshot", () => controller?.getSnapshot());
  ipcMain.handle("voice:get-capture-state", () => captureCoordinator.getState());
  ipcMain.handle("voice:request-capture", (event, action: CaptureRequest) => {
    assertProductRenderer(event);
    if (action !== "start" && action !== "stop") {
      throw new Error("Invalid capture request.");
    }
    if (action === "start" && !controller?.getSnapshot().settings.onboardingComplete) {
      throw new Error("Complete onboarding before starting voice capture.");
    }
    return captureCoordinator.request(action);
  });
  ipcMain.on("voice:capture-lifecycle", (event, value: CaptureLifecycleEvent) => {
    assertMainRenderer(event);
    const statuses: CaptureLifecycleEvent["status"][] = [
      "starting",
      "active",
      "stopping",
      "stopped",
      "error",
    ];
    if (
      !value ||
      !Number.isSafeInteger(value.sessionId) ||
      value.sessionId <= 0 ||
      !statuses.includes(value.status) ||
      (value.error !== undefined && typeof value.error !== "string")
    ) {
      return;
    }
    void acceptCaptureLifecycle(value);
  });
  ipcMain.handle("voice:prepare-dictation", async (event, request: DictationPrepareRequest) => {
    assertMainRenderer(event);
    if (!controller) throw new Error("Cursay is not ready.");
    if (
      !request ||
      typeof request.sampleRate !== "number" ||
      typeof request.forceRefresh !== "boolean" ||
      typeof request.rollover !== "boolean" ||
      (request.reconnectMode !== undefined &&
        request.reconnectMode !== "planned" &&
        request.reconnectMode !== "recovery") ||
      (request.targetMode !== undefined &&
        request.targetMode !== "live" &&
        request.targetMode !== "pinned" &&
        request.targetMode !== "configured") ||
      (request.targetBundleId !== undefined && typeof request.targetBundleId !== "string") ||
      (request.targetContextId !== undefined &&
        (typeof request.targetContextId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            request.targetContextId,
          )))
    ) {
      throw new Error("Invalid dictation preparation request.");
    }
    return controller.prepareDictation(request);
  });
  ipcMain.handle("voice:dictation-started", (event) => {
    assertMainRenderer(event);
    return controller?.markDictationStarted();
  });
  ipcMain.on("voice:dictation-event", (event, value: unknown) => {
    assertMainRenderer(event);
    void controller?.acceptDictationEvent(value);
  });
  ipcMain.on("voice:microphone-level", (event, value: unknown) => {
    assertMainRenderer(event);
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    updatePushToTalkOverlayLevel(value);
  });
  ipcMain.handle("voice:dictation-failed", (event, code: DictationTransportFailureCode) => {
    assertMainRenderer(event);
    const allowed: DictationTransportFailureCode[] = [
      "connection-failed",
      "connection-closed",
      "session-timeout",
      "protocol-error",
    ];
    if (!allowed.includes(code)) throw new Error("Invalid dictation failure code.");
    return controller?.reportTransportFailure(code);
  });
  ipcMain.handle("voice:stop", (event) => {
    assertMainRenderer(event);
    return controller?.stop();
  });
  ipcMain.handle("voice:finish-dictation", (event) => {
    assertMainRenderer(event);
    return controller?.finishDictation();
  });
  ipcMain.handle("voice:update-settings", async (_event, patch: SettingsPatch) => {
    if (typeof patch.launchAtLogin === "boolean") {
      if (!app.isPackaged || !loginLaunchAgent) {
        throw new Error("Launch at login is available only in the packaged app.");
      }
      await loginLaunchAgent.setEnabled(patch.launchAtLogin, getPackagedAppPath());
    }
    return controller?.updateSettings(patch);
  });
  ipcMain.handle("voice:update-command", (_event, command: CommandDefinition) =>
    controller?.updateCommand(command),
  );
  ipcMain.handle("voice:request-accessibility", () => controller?.requestAccessibility());
  ipcMain.handle("voice:refresh-accessibility", () => controller?.refreshAccessibility());
  ipcMain.handle("voice:open-accessibility-settings", async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });
  ipcMain.handle("voice:request-microphone", async () => {
    if (!controller) throw new Error("Cursay is not ready.");
    if (process.platform === "darwin") await systemPreferences.askForMediaAccess("microphone");
    return controller.setMicrophonePermission(getMicrophonePermission());
  });
  ipcMain.handle("voice:refresh-microphone", () =>
    controller?.setMicrophonePermission(getMicrophonePermission()),
  );
  ipcMain.handle("voice:check-auth", () => controller?.checkCodexAuth());
  ipcMain.handle("voice:show-window", (event, screenName?: ManagerScreen) => {
    assertProductRenderer(event);
    const allowed: ManagerScreen[] = ["history", "commands", "settings"];
    const destination = screenName && allowed.includes(screenName) ? screenName : "history";
    showWindow(destination);
  });
}

function assertMainRenderer(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error("Dictation IPC is restricted to the main renderer.");
  }
}

function assertProductRenderer(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): void {
  const senderId = event.sender.id;
  const trusted = [mainWindow, popoverWindow].some(
    (window) => window && !window.isDestroyed() && window.webContents.id === senderId,
  );
  if (!trusted) throw new Error("Cursay IPC is restricted to product renderers.");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (controller?.getSnapshot().settings.onboardingComplete) showPopover();
    else showWindow("settings");
  });
  app.whenReady().then(async () => {
    app.setName("Cursay");
    app.setPath("userData", path.join(app.getPath("appData"), "codex-voice-control"));
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
      callback(permission === "media" && mediaTypes?.includes("audio") === true);
    });

    const settingsStore = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
    await settingsStore.load();
    loginLaunchAgent = new LoginLaunchAgent();
    if (app.isPackaged) {
      const actualLoginState = await loginLaunchAgent.isEnabled();
      if (settingsStore.get().launchAtLogin !== actualLoginState) {
        await settingsStore.patch({ launchAtLogin: actualLoginState });
      } else if (actualLoginState) {
        await loginLaunchAgent.setEnabled(true, getPackagedAppPath());
      }
    }
    const authBroker = new CodexAuthBroker();
    actionBridge = new ActionBridge(getHelperAppPath());
    controller = new VoiceController(settingsStore, authBroker, actionBridge);
    controller.on("snapshot", broadcast);
    controller.on("push-to-talk", handlePushToTalk);
    controller.on("target-binding", handleTargetBinding);
    captureCoordinator.on("state", broadcastCaptureState);
    await controller.initialize();
    controller.setMicrophonePermission(getMicrophonePermission());

    registerIpc();
    const openedAtLogin = process.argv.includes("--launched-at-login");
    const onboardingComplete = controller.getSnapshot().settings.onboardingComplete;
    await createWindow(!openedAtLogin && !onboardingComplete);
    createPushToTalkOverlay();
    createTray();
    await createPopoverWindow();
    broadcast(controller.getSnapshot());
    broadcastCaptureState(captureCoordinator.getState());
    if (!openedAtLogin && onboardingComplete) showPopover();
  });
}

app.on("activate", () => {
  if (quitting) return;
  if (controller?.getSnapshot().settings.onboardingComplete) showPopover();
  else showWindow("settings");
});
app.on("before-quit", () => {
  quitting = true;
  void controller?.dispose();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
