#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const DICTATION_URL = "wss://chatgpt.com/backend-api/dictation/stream";
const TOKEN_KEYS = new Set(["token", "accessToken", "authToken", "access_token"]);

function redact(text) {
  return text
    .replace(/openai-bearer\.[^\s"']+/gi, "openai-bearer.[REDACTED]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[REDACTED_JWT]");
}

function tokenCandidates(value, currentPath = "result", output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${currentPath}.${key}`;
    if (TOKEN_KEYS.has(key) && typeof item === "string" && item.length > 80) {
      output.push({ path: itemPath, token: item });
    } else {
      tokenCandidates(item, itemPath, output);
    }
  }
  return output;
}

function jwtExpiry(token) {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1_000 : null;
  } catch {
    return null;
  }
}

async function firstExecutable() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next local Codex installation.
    }
  }
  throw new Error("Codex CLI was not found.");
}

async function getAuthResult(refreshToken) {
  const executable = await firstExecutable();
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  child.stderr.resume();

  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error("Codex app-server rejected a diagnostic request."));
      else waiter.resolve(message.result);
    }
  });

  function request(method, params, timeoutMs = 10_000) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  try {
    await request("initialize", {
      clientInfo: {
        name: "codex-voice-control-diagnostic",
        title: "Codex Voice Control Diagnostic",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return await request("getAuthStatus", { includeToken: true, refreshToken });
  } finally {
    child.kill("SIGTERM");
  }
}

async function probe(token) {
  return new Promise((resolve) => {
    let settled = false;
    const variant = process.env.DICTATION_PROBE_VARIANT ?? "baseline";
    const browserHeaders = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    };
    const headers =
      variant === "browser"
        ? browserHeaders
        : variant === "browser-chatgpt-origin"
          ? { ...browserHeaders, Origin: "https://chatgpt.com" }
          : variant === "browser-file-origin"
            ? { ...browserHeaders, Origin: "file://" }
            : variant === "browser-null-origin"
              ? { ...browserHeaders, Origin: "null" }
              : undefined;
    const socket = new WebSocket(
      DICTATION_URL,
      ["chatgpt-dictation", `openai-bearer.${token}`, "codex-desktop"],
      { handshakeTimeout: 10_000, perMessageDeflate: false, headers },
    );

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolve(result);
    };

    socket.once("open", () => finish({ outcome: "open", protocol: socket.protocol || null }));
    socket.once("unexpected-response", (_request, response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        if (chunks.reduce((sum, item) => sum + item.length, 0) < 8_192) chunks.push(chunk);
      });
      response.once("end", () => {
        finish({
          outcome: "rejected",
          variant,
          statusCode: response.statusCode ?? null,
          requestId: response.headers["x-request-id"] ?? null,
          server: response.headers.server ?? null,
          cfMitigated: response.headers["cf-mitigated"] ?? null,
          cfRay: response.headers["cf-ray"] ?? null,
          body: redact(Buffer.concat(chunks).toString("utf8"))
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 1_000),
        });
      });
    });
    socket.once("error", (error) => finish({ outcome: "error", message: redact(error.message) }));
  });
}

const refreshToken = process.argv.includes("--refresh");
const authResult = await getAuthResult(refreshToken);
const candidates = tokenCandidates(authResult);
console.log(JSON.stringify({
  phase: "auth",
  refreshToken,
  candidateCount: candidates.length,
  candidates: candidates.map(({ path: tokenPath, token }) => ({
    path: tokenPath,
    length: token.length,
    jwtLike: token.split(".").length === 3,
    expiresAt: jwtExpiry(token),
  })),
}));

if (candidates.length === 0) throw new Error("No usable ChatGPT token was returned.");
const result = await probe(candidates[0].token);
console.log(JSON.stringify({ phase: "websocket", ...result }));
process.exitCode = result.outcome === "open" ? 0 : 2;
