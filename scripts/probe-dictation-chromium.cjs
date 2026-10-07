const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const DICTATION_URL = "wss://chatgpt.com/backend-api/dictation/stream";
const CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const TOKEN_KEYS = new Set(["token", "accessToken", "authToken", "access_token"]);
const deliveryModeArgument = process.argv.find((item) => item.startsWith("--delivery-mode="));
const deliveryMode = deliveryModeArgument?.slice("--delivery-mode=".length) || null;
if (deliveryMode != null && !["final_only", "segment", "delta"].includes(deliveryMode)) {
  throw new Error("Unsupported diagnostic delivery mode.");
}

function findToken(value) {
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (TOKEN_KEYS.has(key) && typeof item === "string" && item.length > 80) return item;
    const nested = findToken(item);
    if (nested) return nested;
  }
  return null;
}

async function getToken() {
  const child = spawn(CODEX, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error("Codex app-server rejected the probe request."));
      else waiter.resolve(message.result);
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  };

  try {
    await request("initialize", {
      clientInfo: {
        name: "codex-voice-control-chromium-probe",
        title: "Codex Voice Control Chromium Probe",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const result = await request("getAuthStatus", { includeToken: true, refreshToken: false });
    const token = findToken(result);
    if (!token) throw new Error("No usable ChatGPT token was returned.");
    return token;
  } finally {
    child.kill("SIGTERM");
  }
}

app.whenReady().then(async () => {
  const token = await getToken();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "probe-dictation-chromium-preload.cjs"),
    },
  });

  const timer = setTimeout(() => {
    console.log(JSON.stringify({ outcome: "host-timeout" }));
    app.exit(2);
  }, 15_000);
  ipcMain.once("dictation-probe:result", (_event, result) => {
    clearTimeout(timer);
    console.log(JSON.stringify(result));
    app.exit(result.outcome === "open" || result.outcome === "session-started" ? 0 : 2);
  });
  await window.loadFile(path.join(__dirname, "probe-dictation-chromium.html"));
  window.webContents.send("dictation-probe:start", {
    websocketUrl: DICTATION_URL,
    protocols: ["chatgpt-dictation", `openai-bearer.${token}`, "codex-desktop"],
    deliveryMode,
  });
}).catch((error) => {
  console.error(error instanceof Error ? error.message : "Chromium probe failed.");
  app.exit(2);
});
