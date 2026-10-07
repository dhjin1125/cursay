class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(1024);
    this.pendingOffset = 0;
    this.smoothedGain = 1;
    this.levelTick = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const amount = Math.min(channel.length - sourceOffset, this.pending.length - this.pendingOffset);
      this.pending.set(channel.subarray(sourceOffset, sourceOffset + amount), this.pendingOffset);
      this.pendingOffset += amount;
      sourceOffset += amount;
      if (this.pendingOffset === this.pending.length) {
        this.flushFrame();
        this.pendingOffset = 0;
      }
    }
    return true;
  }

  flushFrame() {
    let sum = 0;
    let peak = 0;
    for (const sample of this.pending) {
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / this.pending.length);
    const desiredGain = rms < 0.003 ? 1 : Math.min(4, 0.063 / Math.max(rms, 0.000001));
    this.smoothedGain += (desiredGain - this.smoothedGain) * 0.35;
    const peakLimitedGain = peak > 0 ? Math.min(this.smoothedGain, 0.708 / peak) : this.smoothedGain;
    const pcm = new Int16Array(this.pending.length);

    for (let index = 0; index < this.pending.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.pending[index] * peakLimitedGain));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    this.port.postMessage({ type: "frame", bytes: pcm.buffer }, [pcm.buffer]);
    this.levelTick += 1;
    if (this.levelTick >= 2) {
      this.levelTick = 0;
      this.port.postMessage({ type: "level", value: Math.min(1, rms / 0.12) });
    }
  }
}

registerProcessor("pcm16-capture", Pcm16CaptureProcessor);
