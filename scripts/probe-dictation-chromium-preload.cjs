const { ipcRenderer } = require("electron");

ipcRenderer.once("dictation-probe:start", (_event, payload) => {
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    ipcRenderer.send("dictation-probe:result", result);
  };

  const socket = new WebSocket(payload.websocketUrl, payload.protocols);
  const timer = setTimeout(() => {
    socket.close();
    finish({ outcome: "timeout" });
  }, 10_000);

  socket.addEventListener("open", () => {
    if (!payload.deliveryMode) {
      clearTimeout(timer);
      finish({ outcome: "open", protocol: socket.protocol || null });
      socket.close();
      return;
    }
    socket.send(JSON.stringify({
      type: "session.start",
      config: {
        input_audio_format: "pcm16",
        sample_rate_hz: 48_000,
        num_channels: 1,
        max_buffer_size_bytes: 4_194_304,
        max_utterance_duration_ms: 30_000,
        session_ttl_ms: 300_000,
        provider_mode: "streaming_sse",
        transcript_delivery_mode: payload.deliveryMode,
        vad: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    }));
  }, { once: true });
  socket.addEventListener("message", (event) => {
    if (!payload.deliveryMode || typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      finish({ outcome: "invalid-event" });
      socket.close();
      return;
    }
    if (message.type === "session.started") {
      clearTimeout(timer);
      socket.send(JSON.stringify({ type: "session.close" }));
      finish({
        outcome: "session-started",
        protocol: socket.protocol || null,
        requestedMode: payload.deliveryMode,
        acceptedMode: message.session?.config?.transcript_delivery_mode ?? null,
        providerMode: message.session?.config?.provider_mode ?? null,
      });
      socket.close();
    } else if (message.type === "session.error") {
      clearTimeout(timer);
      finish({
        outcome: "session-error",
        fatal: message.fatal === true,
        errorCode: typeof message.error?.code === "string" ? message.error.code : null,
      });
      socket.close();
    }
  });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    finish({ outcome: "error" });
  }, { once: true });
  socket.addEventListener("close", (event) => {
    clearTimeout(timer);
    finish({ outcome: "closed", code: event.code, reason: event.reason || null });
  }, { once: true });
});
