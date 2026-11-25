
import { GoogleGenAI } from '@google/genai';

const WORKLET = `
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(512);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let offset = 0;

    while (offset < input.length) {
      const count = Math.min(
        512 - this.offset,
        input.length - offset
      );

      this.buffer.set(
        input.subarray(offset, offset + count),
        this.offset
      );

      this.offset += count;
      offset += count;

      if (this.offset === 512) {
        const chunk = this.buffer;
        this.buffer = new Float32Array(512);
        this.offset = 0;

        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }

    return true;
  }
}

registerProcessor('pcm-cap', PCMCapture);
`;

const b64 = data => {
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) {
    binary += String.fromCharCode(
      ...data.subarray(i, i + 8192)
    );
  }
  return btoa(binary);
};

const unb64 = data =>
  Uint8Array.from(atob(data), c => c.charCodeAt(0));

function level(analyser, time, freq) {
  if (!analyser) return { rms: 0, bass: 0 };

  analyser.getByteTimeDomainData(time);

  let sum = 0;

  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128;
    sum += v * v;
  }

  analyser.getByteFrequencyData(freq);

  let bass = 0;

  for (let i = 1; i < 9; i++) {
    bass += freq[i];
  }

  return {
    rms: Math.min(1, Math.sqrt(sum / time.length) * 3.2),
    bass: Math.min(1, bass / 8 / 255 * 1.2)
  };
}

export class Live {
  constructor(h) {
    this.h = h;
    this.active = false;
    this.muted = false;
    this.q = new Set();
    this.next = 0;
    this.generation = 0;
    this.reset();
  }

  reset() {
    this.uText = '';
    this.aText = '';
    this.turnDone = true;
    this.speechAt = 0;
    this.lastLoud = 0;
    this.gotOutput = false;
  }

  mic() {
    return !this.muted
      ? level(this.micAn, this.micBuf, this.micFq)
      : { rms: 0, bass: 0 };
  }

  out() {
    return level(this.outAn, this.outBuf, this.outFq);
  }

  async start() {
    if (this.active) return;

    this.active = true;
    const generation = ++this.generation;

    this.h.state('connecting');

    try {
      const stream = this.stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });

      const ctx = this.ctx =
        new AudioContext({ latencyHint: 'interactive' });

      await ctx.resume();

      const analyser = fft => {
        const a = ctx.createAnalyser();
        a.fftSize = fft;
        a.smoothingTimeConstant = 0.45;
        return a;
      };

      const source = ctx.createMediaStreamSource(stream);

      this.micAn = analyser(512);
      this.micBuf = new Uint8Array(512);
      this.micFq = new Uint8Array(256);
      source.connect(this.micAn);

      this.outAn = analyser(512);
      this.outBuf = new Uint8Array(512);
      this.outFq = new Uint8Array(256);
      this.outAn.connect(ctx.destination);

      const url = URL.createObjectURL(
        new Blob([WORKLET], { type: 'text/javascript' })
      );

      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const node = this.node =
        new AudioWorkletNode(ctx, 'pcm-cap');

      const silent = ctx.createGain();
      silent.gain.value = 0;

      source.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);

      const ratio = ctx.sampleRate / 16000;

      node.port.onmessage = event => {
        if (!this.active || !this.session || this.muted) return;

        const input = event.data;
        const count = Math.floor(input.length / ratio);

        if (!count) return;

        const output = new Int16Array(count);

        for (let i = 0; i < count; i++) {
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

          output[i] = sample < 0
            ? sample * 32768
            : sample * 32767;
        }

        try {
          this.session.sendRealtimeInput({
            audio: {
              data: b64(new Uint8Array(output.buffer)),
              mimeType: 'audio/pcm;rate=16000'
            }
          });
        } catch (error) {
          console.warn('Audio send failed', error);
        }
      };

      // Request a short-lived token from your backend.
      const response = await fetch('/api/live-token', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + await this.h.jwt()
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Token request failed');
      }

      if (!this.active || generation !== this.generation) return;

      const ai = new GoogleGenAI({
        apiKey: data.token,
        httpOptions: { apiVersion: 'v1alpha' }
      });

      const session = await ai.live.connect({
        model: data.model,
        config: data.config,
        callbacks: {
          onopen: () => {
            if (generation !== this.generation) return;
            this.h.state('listening');
            this.h.opened?.();
          },

          onmessage: message => {
            if (generation === this.generation) {
              this.msg(message);
            }
          },

          onerror: error => {
            if (generation === this.generation) {
              this.h.error(
                error?.message || 'Gemini connection error'
              );
            }
          },

          onclose: () => {
            if (generation === this.generation) this.stop();
          }
        }
      });

      if (!this.active || generation !== this.generation) {
        session.close();
        return;
      }

      this.session = session;
      this.timer = setInterval(() => this.tick(), 75);

    } catch (error) {
      if (generation === this.generation) {
        this.stop();
        throw error;
      }
    }
  }

  tick() {
    if (!this.active) return;

    const now = performance.now();
    const audio = this.mic();

    if (audio.rms > 0.14) {
      this.speechAt = now;
      this.lastLoud = now;
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

      if (!this.q.size) {
        this.h.state('listening');
      }
    }
  }

  play(data) {
    if (!this.ctx || !this.active) return;

    const bytes = unb64(data);

    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2)
    );

    const buffer = this.ctx.createBuffer(
      1,
      samples.length,
      24000
    );

    const channel = buffer.getChannelData(0);

    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 32768;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outAn);

    const startAt = Math.max(
      this.next,
      this.ctx.currentTime + 0.015
    );

    source.start(startAt);
    this.next = startAt + buffer.duration;

    this.q.add(source);
    this.gotOutput = true;

    this.h.state('speaking');

    source.onended = () => {
      this.q.delete(source);

      if (!this.q.size && this.turnDone && this.active) {
        this.h.state('listening');
      }
    };
  }

  flush() {
    for (const source of this.q) {
      source.onended = null;

      try {
        source.stop();
      } catch {}
    }

    this.q.clear();
    this.next = 0;
    this.gotOutput = false;
  }

  interrupt() {
    this.flush();
    this.h.state('listening');
  }

  async tools(calls) {
    this.h.state('thinking');

    const responses = await Promise.all(
      calls.map(async call => {
        try {
          const response = await fetch('/api/tool', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + await this.h.jwt()
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
            response: { ok: false, error: 'network' }
          };
        }
      })
    );

    try {
      this.session?.sendToolResponse({
        functionResponses: responses
      });
    } catch (error) {
      console.warn('Tool response failed', error);
    }
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

    this.stream?.getAudioTracks().forEach(
      track => track.enabled = !value
    );

    if (value) {
      try {
        this.session?.sendRealtimeInput({
          audioStreamEnd: true
        });
      } catch {}
    }
  }

  stop() {
    if (!this.active) return;

    this.active = false;
    this.generation++;

    clearInterval(this.timer);

    this.persist();
    this.flush();

    try {
      this.session?.close();
    } catch {}

    this.session = null;

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

    this.reset();
    this.h.state('idle');
  }
}
