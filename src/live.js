import { GoogleGenAI } from '@google/genai';

// Client-side voice effects. rate>1 raises pitch (and speed) slightly; ring = robot ring-modulator.
const FX = {
  male:   { rate: 1,    ring: 0 },
  female: { rate: 1,    ring: 0 },
  boy:    { rate: 1.1,  ring: 0 },
  girl:   { rate: 1.08, ring: 0 },
  robot:  { rate: 1,    ring: 1 }
};

// LATENCY FIX: ~40ms chunks instead of 512-sample (~10ms) chunks,
// so far fewer tiny WebSocket messages are sent per second.
const WORKLET = `
const SIZE = Math.round(sampleRate * 0.04);

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(SIZE);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let i = 0;

    while (i < input.length) {
      const count = Math.min(SIZE - this.offset, input.length - i);

      this.buffer.set(input.subarray(i, i + count), this.offset);
      this.offset += count;
      i += count;

      if (this.offset === SIZE) {
        const output = this.buffer;
        this.buffer = new Float32Array(SIZE);
        this.offset = 0;
        this.port.postMessage(output, [output.buffer]);
      }
    }

    return true;
  }
}

registerProcessor('pcm-cap', PCMCapture);
`;

const encode = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 8192)
    );
  }
  return btoa(binary);
};

const decode = value =>
  Uint8Array.from(atob(value), c => c.charCodeAt(0));

function measure(analyser, time, frequency) {
  if (!analyser) return { rms: 0, bass: 0 };

  analyser.getByteTimeDomainData(time);

  let sum = 0;

  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128;
    sum += v * v;
  }

  analyser.getByteFrequencyData(frequency);

  let bass = 0;
  for (let i = 1; i < 9; i++) bass += frequency[i];

  return {
    rms: Math.min(1, Math.sqrt(sum / time.length) * 3.2),
    bass: Math.min(1, bass / 8 / 255 * 1.2)
  };
}

export class Live {
  constructor(handlers) {
    this.h = handlers;
    this.active = false;
    this.muted = false;
    this.sources = new Set();
    this.nextAudioTime = 0;
    this.warm = null;
    this.warmAt = 0;
    this.voiceKey = 'female';
    this.reset();
  }

  // Takes effect on the next connection (Gemini fixes the voice when a session opens).
  setVoice(key) {
    this.voiceKey = FX[key] ? key : 'female';
    this.warm = null; // a prewarmed token was made for the old voice
  }

  // SPEED: fetch the Gemini token (server round trip) without waiting on anything else
  async fetchToken() {
    const response = await fetch('/api/live-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await this.h.jwt()}`
      },
      body: JSON.stringify({ voice: this.voiceKey })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Live token failed');
    return result;
  }

  // Call when the user is about to start (pointer down / hover). Token is valid ~60s, so reuse within 45s.
  prewarm() {
    if (this.active) return;
    if (this.warm && performance.now() - this.warmAt < 40000) return;
    this.warmAt = performance.now();
    this.warm = this.fetchToken().catch(() => null);
  }

  takeToken() {
    const w = this.warm;
    this.warm = null;
    if (w && performance.now() - this.warmAt < 45000) return w.then(r => r || this.fetchToken());
    return this.fetchToken();
  }

  reset() {
    this.uText = '';
    this.aText = '';
    this.turnDone = true;
    this.speechAt = 0;
    this.lastLoud = 0;
    this.tLoud = 0;
    this.gotOutput = false;
    this.stopping = false;
  }

  mic() {
    return !this.muted
      ? measure(this.micAn, this.micBuf, this.micFq)
      : { rms: 0, bass: 0 };
  }

  out() {
    return measure(this.outAn, this.outBuf, this.outFq);
  }

  async start() {
    if (this.active) return;

    this.active = true;
    this.h.state('connecting');

    // Start the token request immediately, in parallel with microphone/audio setup.
    const tokenP = this.takeToken();
    tokenP.catch(() => {});

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone requires HTTPS');
      }

      // Start microphone immediately.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });

      const ctx = this.ctx = new AudioContext({
        latencyHint: 'interactive'
      });

      await ctx.resume();

      const source = ctx.createMediaStreamSource(this.stream);

      const createAnalyser = () => {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.45;
        return analyser;
      };

      this.micAn = createAnalyser();
      this.micBuf = new Uint8Array(512);
      this.micFq = new Uint8Array(256);

      source.connect(this.micAn);

      this.outAn = createAnalyser();
      this.outBuf = new Uint8Array(512);
      this.outFq = new Uint8Array(256);

      this.outAn.connect(ctx.destination);

      // Voice effects bus: AI audio -> bus -> (dry + optional robot ring-mod) -> analyser -> speakers
      const fx = FX[this.voiceKey] || FX.female;
      this.rate = fx.rate;
      const bus = this.bus = ctx.createGain();
      const dry = ctx.createGain();
      dry.gain.value = fx.ring ? 0.3 : 1;
      bus.connect(dry);
      dry.connect(this.outAn);
      if (fx.ring) {
        const ring = ctx.createGain();
        ring.gain.value = 0;
        const osc = this.osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 55;
        osc.connect(ring.gain);
        osc.start();
        const wet = ctx.createGain();
        wet.gain.value = 1.15;
        bus.connect(ring);
        ring.connect(wet);
        wet.connect(this.outAn);
      }

      // Low-latency microphone capture.
      const blob = new Blob([WORKLET], {
        type: 'text/javascript'
      });

      const workletURL = URL.createObjectURL(blob);

      try {
        await ctx.audioWorklet.addModule(workletURL);
      } finally {
        URL.revokeObjectURL(workletURL);
      }

      this.node = new AudioWorkletNode(ctx, 'pcm-cap');

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      source.connect(this.node);
      this.node.connect(silentGain);
      silentGain.connect(ctx.destination);

      const ratio = ctx.sampleRate / 16000;

      this.node.port.onmessage = event => {
        if (!this.session || this.muted || !this.active) return;

        const input = event.data;
        const length = Math.floor(input.length / ratio);

        const pcm = new Int16Array(length);

        for (let i = 0; i < length; i++) {
          const start = Math.floor(i * ratio);
          const end = Math.min(
            input.length,
            Math.floor((i + 1) * ratio)
          );

          let sum = 0;

          for (let j = start; j < end; j++) {
            sum += input[j];
          }

          const sample = Math.max(
            -1,
            Math.min(1, sum / Math.max(1, end - start))
          );

          pcm[i] = sample < 0
            ? sample * 32768
            : sample * 32767;
        }

        try {
          const bytes = new Uint8Array(
            pcm.buffer,
            pcm.byteOffset,
            pcm.byteLength
          );

          const result = this.session.sendRealtimeInput({
            audio: {
              data: encode(bytes),
              mimeType: 'audio/pcm;rate=16000'
            }
          });

          result?.catch?.(() => {});
        } catch {}
      };

      // Token was requested in parallel with mic setup (or prewarmed).
      const result = await tokenP;

      const ai = new GoogleGenAI({
        apiKey: result.token,
        httpOptions: { apiVersion: 'v1alpha' }
      });

      this.session = await ai.live.connect({
        model: result.model,
        config: result.config,

        callbacks: {
          onopen: () => {
            if (!this.active) return;
            this.h.state('listening');
            this.h.opened?.();
          },

          onmessage: message => this.msg(message),

          onerror: error => {
            this.h.error(
              error?.message || 'Connection error'
            );
          },

          onclose: () => {
            if (this.active) this.stop();
          }
        }
      });

      // Faster local silence detection.
      this.timer = setInterval(() => this.tick(), 100);

    } catch (error) {
      this.stop();
      throw error;
    }
  }

  tick() {
    const now = performance.now();
    const level = this.mic();

    if (level.rms > 0.14) {
      this.speechAt = now;
      this.lastLoud = now;
      this.tLoud = now; // latency timer reference
    }

    if (
      this.h.mode() === 'listening' &&
      this.speechAt &&
      !this.gotOutput &&
      now - this.lastLoud > 400
    ) {
      this.h.state('thinking');
    }
  }

  msg(message) {
    const content = message.serverContent;

    if (message.toolCall?.functionCalls) {
      this.tools(message.toolCall.functionCalls);
    }

    if (!content) return;

    if (content.interrupted) {
      this.flush();
      this.persist();
      this.h.state('listening');
    }

    if (content.inputTranscription?.text) {
      this.uText += content.inputTranscription.text;
      this.turnDone = false;

      this.h.transcript(this.uText, this.aText);
    }

    if (content.outputTranscription?.text) {
      this.aText += content.outputTranscription.text;

      this.h.transcript(this.uText, this.aText);
    }

    for (const part of content.modelTurn?.parts || []) {
      if (
        part.inlineData?.data &&
        /audio\/pcm/i.test(part.inlineData.mimeType || '')
      ) {
        this.play(part.inlineData.data);
      }
    }

    if (content.turnComplete) {
      this.persist();
      this.turnDone = true;
      this.gotOutput = false;
      this.speechAt = 0;

      if (!this.sources.size) {
        this.h.state('listening');
      }
    }
  }

  play(data) {
    if (!this.ctx || !this.active) return;

    // Latency timer: last loud mic moment -> first AI audio
    if (!this.gotOutput && this.tLoud) {
      const ms = Math.round(performance.now() - this.tLoud);
      console.log('[lat] you stopped → first AI audio:', ms, 'ms');
      this.h.latency?.(ms);
      this.tLoud = 0;
    }

    const bytes = decode(data);

    if (bytes.byteLength < 2) return;

    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2)
    );

    const audio = this.ctx.createBuffer(
      1,
      samples.length,
      24000
    );

    const channel = audio.getChannelData(0);

    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 32768;
    }

    const source = this.ctx.createBufferSource();

    source.buffer = audio;
    source.playbackRate.value = this.rate || 1;
    source.connect(this.bus || this.outAn);

    // Schedule audio without unnecessary gaps.
    const startAt = Math.max(
      this.nextAudioTime,
      this.ctx.currentTime + 0.015
    );

    source.start(startAt);

    this.nextAudioTime = startAt + audio.duration / (this.rate || 1);

    this.sources.add(source);
    this.gotOutput = true;

    this.h.state('speaking');

    source.onended = () => {
      this.sources.delete(source);

      if (!this.sources.size && this.turnDone) {
        this.h.state('listening');
      }
    };
  }

  flush() {
    for (const source of this.sources) {
      source.onended = null;

      try {
        source.stop();
      } catch {}
    }

    this.sources.clear();
    this.nextAudioTime = 0;
    this.gotOutput = false;
  }

  interrupt() {
    this.flush();
    this.h.state('listening');
  }

  async tools(calls) {
    this.h.state('thinking');

    const t0 = performance.now();

    const responses = await Promise.all(
      calls.map(async call => {
        try {
          const response = await fetch('/api/tool', {
            method: 'POST',

            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${await this.h.jwt()}`
            },

            body: JSON.stringify({
              name: call.name,
              args: call.args
            })
          });

          return {
            id: call.id,
            name: call.name,
            response: await response.json()
          };

        } catch {
          return {
            id: call.id,
            name: call.name,
            response: {
              ok: false,
              error: 'Network error'
            }
          };
        }
      })
    );

    console.log(
      '[lat] tools',
      calls.map(c => c.name).join(','),
      Math.round(performance.now() - t0),
      'ms'
    );

    try {
      this.session?.sendToolResponse({
        functionResponses: responses
      });
    } catch {}
  }

  persist() {
    const user = this.uText.trim();
    const assistant = this.aText.trim();

    this.uText = '';
    this.aText = '';

    if (user) this.h.save('user', user);
    if (assistant) this.h.save('assistant', assistant);
  }

  setMuted(value) {
    this.muted = value;

    this.stream?.getAudioTracks().forEach(track => {
      track.enabled = !value;
    });

    if (value) {
      try {
        this.session?.sendRealtimeInput({
          audioStreamEnd: true
        });
      } catch {}
    }
  }

  stop() {
    if (!this.active || this.stopping) return;

    this.stopping = true;
    this.active = false;

    clearInterval(this.timer);

    this.persist();
    this.flush();

    const session = this.session;
    this.session = null;

    try {
      session?.close();
    } catch {}

    this.stream?.getTracks().forEach(track => track.stop());

    try {
      this.node?.disconnect();
    } catch {}

    try {
      this.ctx?.close();
    } catch {}

    this.stream = null;
    this.node = null;
    this.ctx = null;
    this.micAn = null;
    this.outAn = null;
    this.bus = null;
    this.osc = null;

    this.reset();
    this.h.state('idle');
  }
}