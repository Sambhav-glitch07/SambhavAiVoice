import { GoogleGenAI } from '@google/genai';

const WORKLET = `
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];

    if (channel) {
      this.buffer.push(new Float32Array(channel));
      this.length += channel.length;

      if (this.length >= 512) {
        const output = new Float32Array(this.length);
        let offset = 0;

        for (const chunk of this.buffer) {
          output.set(chunk, offset);
          offset += chunk.length;
        }

        this.port.postMessage(output, [output.buffer]);
        this.buffer = [];
        this.length = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture', PCMCapture);
`;

function toBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function floatToPCM16(input) {
  const output = new Int16Array(input.length);

  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0
      ? sample * 0x8000
      : sample * 0x7fff;
  }

  return output;
}

function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;

    output[i] =
      input[left] * (1 - fraction) +
      input[right] * fraction;
  }

  return output;
}

function rms(analyser, data) {
  if (!analyser) return 0;

  analyser.getByteTimeDomainData(data);

  let total = 0;

  for (let i = 0; i < data.length; i++) {
    const value = (data[i] - 128) / 128;
    total += value * value;
  }

  return Math.sqrt(total / data.length);
}

export class Live {
  constructor(handlers = {}) {
    this.h = handlers;

    this.active = false;
    this.starting = false;
    this.micMuted = false;
    this.speakerMuted = false;

    this.stream = null;
    this.ctx = null;
    this.session = null;

    this.source = null;
    this.capture = null;
    this.silentGain = null;

    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGain = null;

    this.queue = new Set();
    this.nextPlaybackTime = 0;

    this.generation = 0;
    this.lastVoiceAt = 0;
    this.lastOutputAt = 0;
    this.levelTimer = null;

    this.micMeter = new Uint8Array(1024);
    this.outputMeter = new Uint8Array(1024);

    this.workletUrl = null;
  }

  emitMode(mode) {
    this.h.mode?.(mode);
    this.h.state?.(mode);
  }

  async start() {
    if (this.active || this.starting) return;

    this.starting = true;
    const generation = ++this.generation;

    this.emitMode('connecting');

    try {
      const jwt = await this.h.jwt?.();

      if (!jwt) {
        throw new Error('Please sign in before starting a conversation.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      this.stream = stream;

      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      this.ctx = new AudioContextClass({
        latencyHint: 'interactive'
      });

      await this.ctx.resume();

      if (generation !== this.generation) {
        await this.cleanupAudio();
        return;
      }

      this.inputAnalyser = this.ctx.createAnalyser();
      this.inputAnalyser.fftSize = 1024;
      this.inputAnalyser.smoothingTimeConstant = 0.7;

      this.outputAnalyser = this.ctx.createAnalyser();
      this.outputAnalyser.fftSize = 1024;
      this.outputAnalyser.smoothingTimeConstant = 0.65;

      this.outputGain = this.ctx.createGain();
      this.outputGain.gain.value = this.speakerMuted ? 0 : 1;

      this.outputAnalyser.connect(this.outputGain);
      this.outputGain.connect(this.ctx.destination);

      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.inputAnalyser);

      const blob = new Blob([WORKLET], {
        type: 'application/javascript'
      });

      this.workletUrl = URL.createObjectURL(blob);

      await this.ctx.audioWorklet.addModule(this.workletUrl);

      if (generation !== this.generation) {
        await this.cleanupAudio();
        return;
      }

      this.capture = new AudioWorkletNode(
        this.ctx,
        'pcm-capture',
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit'
        }
      );

      this.silentGain = this.ctx.createGain();
      this.silentGain.gain.value = 0;

      this.source.connect(this.capture);
      this.capture.connect(this.silentGain);
      this.silentGain.connect(this.ctx.destination);

      this.capture.port.onmessage = event => {
        if (
          !this.active ||
          this.micMuted ||
          !this.session ||
          generation !== this.generation
        ) {
          return;
        }

        const input = event.data;

        if (!(input instanceof Float32Array)) return;

        const converted = resample(
          input,
          this.ctx.sampleRate,
          16000
        );

        if (!converted.length) return;

        const pcm = floatToPCM16(converted);

        this.session.sendRealtimeInput({
          audio: {
            data: toBase64(
              new Uint8Array(
                pcm.buffer,
                pcm.byteOffset,
                pcm.byteLength
              )
            ),
            mimeType: 'audio/pcm;rate=16000'
          }
        });
      };

      const response = await fetch('/api/live-token', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          voice: this.h.voice?.() || 'female'
        })
      });

      const tokenData = await response.json();

      if (!response.ok || !tokenData.token) {
        throw new Error(
          tokenData.error || 'Could not create a live session.'
        );
      }

      if (generation !== this.generation) {
        await this.cleanupAudio();
        return;
      }

      const ai = new GoogleGenAI({
        apiKey: tokenData.token
      });

      const session = await ai.live.connect({
        model: tokenData.model,
        config: tokenData.config,

        callbacks: {
          onopen: () => {
            if (generation !== this.generation) return;

            this.active = true;
            this.starting = false;
            this.lastVoiceAt = Date.now();

            this.emitMode('listening');
            this.startMeter();
          },

          onmessage: message => {
            if (generation !== this.generation) return;
            this.handleMessage(message);
          },

          onerror: error => {
            if (generation !== this.generation) return;

            console.error('Live session error:', error);
            this.h.error?.(
              error?.message || 'Live connection error.'
            );
          },

          onclose: event => {
            if (generation !== this.generation) return;

            this.active = false;
            this.starting = false;
            this.session = null;

            this.stopMeter();
            this.flush();

            this.h.closed?.(event);
            this.emitMode('ended');
          }
        }
      });

      if (generation !== this.generation) {
        try {
          session.close();
        } catch {}

        await this.cleanupAudio();
        return;
      }

      this.session = session;
    } catch (error) {
      console.error('Live start error:', error);

      if (generation === this.generation) {
        this.active = false;
        this.starting = false;

        await this.cleanupAudio();

        this.h.error?.(
          error?.message || 'Could not start the conversation.'
        );

        this.emitMode('error');
      }
    }
  }

  handleMessage(message) {
    const server = message?.serverContent;

    if (message?.toolCall?.functionCalls?.length) {
      this.handleTools(message.toolCall.functionCalls);
    }

    if (!server) return;

    const inputText =
      server.inputTranscription?.text;

    if (inputText) {
      this.h.transcript?.('user', inputText);
      this.h.save?.('user', inputText);
    }

    const outputText =
      server.outputTranscription?.text;

    if (outputText) {
      this.h.transcript?.('assistant', outputText);
      this.h.save?.('assistant', outputText);
    }

    if (server.interrupted) {
      this.flush();
      this.emitMode('listening');
    }

    const parts = server.modelTurn?.parts || [];

    for (const part of parts) {
      const data = part?.inlineData?.data;

      if (data) {
        this.play(data);
      }
    }

    if (server.turnComplete) {
      this.emitMode('listening');
    } else if (parts.length) {
      this.emitMode('speaking');
    }
  }

  async handleTools(functionCalls) {
    for (const call of functionCalls) {
      try {
        const jwt = await this.h.jwt?.();

        const response = await fetch('/api/tool', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: call.name,
            args: call.args || {}
          })
        });

        const data = await response.json();

        this.session?.sendToolResponse({
          functionResponses: [{
            id: call.id,
            name: call.name,
            response: data.result || data
          }]
        });
      } catch (error) {
        console.error('Tool call error:', error);

        this.session?.sendToolResponse({
          functionResponses: [{
            id: call.id,
            name: call.name,
            response: {
              ok: false,
              error: 'Tool execution failed.'
            }
          }]
        });
      }
    }
  }

  play(base64) {
    if (!this.ctx || !this.outputAnalyser) return;

    try {
      const bytes = fromBase64(base64);
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
      source.connect(this.outputAnalyser);

      const startAt = Math.max(
        this.ctx.currentTime + 0.015,
        this.nextPlaybackTime
      );

      this.nextPlaybackTime = startAt + audio.duration;

      this.queue.add(source);

      source.onended = () => {
        this.queue.delete(source);

        if (!this.queue.size && this.active) {
          this.emitMode('listening');
        }
      };

      source.start(startAt);

      this.lastOutputAt = Date.now();
      this.emitMode('speaking');
    } catch (error) {
      console.error('Audio playback error:', error);
    }
  }

  startMeter() {
    this.stopMeter();

    this.levelTimer = setInterval(() => {
      if (!this.active) return;

      const inputLevel = rms(
        this.inputAnalyser,
        this.micMeter
      );

      const outputLevel = rms(
        this.outputAnalyser,
        this.outputMeter
      );

      this.h.level?.({
        input: inputLevel,
        output: outputLevel
      });

      if (
        outputLevel > 0.018 ||
        Date.now() - this.lastOutputAt < 250
      ) {
        this.emitMode('speaking');
      } else if (inputLevel > 0.025) {
        this.lastVoiceAt = Date.now();
        this.emitMode('listening');
      }
    }, 80);
  }

  stopMeter() {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  interrupt() {
    this.flush();

    try {
      this.session?.sendRealtimeInput({
        audioStreamEnd: true
      });
    } catch {}

    if (this.active) {
      this.emitMode('listening');
    }
  }

  flush() {
    for (const source of this.queue) {
      try {
        source.stop();
      } catch {}

      try {
        source.disconnect();
      } catch {}
    }

    this.queue.clear();

    if (this.ctx) {
      this.nextPlaybackTime = this.ctx.currentTime;
    } else {
      this.nextPlaybackTime = 0;
    }
  }

  setSpeakerMuted(muted) {
    this.speakerMuted = Boolean(muted);

    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setTargetAtTime(
        this.speakerMuted ? 0 : 1,
        this.ctx.currentTime,
        0.015
      );
    }

    this.h.speakerMuted?.(this.speakerMuted);
  }

  // Kept as an alias for compatibility with older main.js code.
  setMuted(muted) {
    this.setSpeakerMuted(muted);
  }

  setMicMuted(muted) {
    this.micMuted = Boolean(muted);

    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) {
        track.enabled = !this.micMuted;
      }
    }

    if (this.micMuted) {
      try {
        this.session?.sendRealtimeInput({
          audioStreamEnd: true
        });
      } catch {}
    }
  }

  async cleanupAudio() {
    this.stopMeter();
    this.flush();

    if (this.capture) {
      this.capture.port.onmessage = null;
      try { this.capture.disconnect(); } catch {}
      this.capture = null;
    }

    for (const node of [
      this.source,
      this.inputAnalyser,
      this.outputAnalyser,
      this.outputGain,
      this.silentGain
    ]) {
      try { node?.disconnect(); } catch {}
    }

    this.source = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGain = null;
    this.silentGain = null;

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }

    if (this.ctx) {
      const context = this.ctx;
      this.ctx = null;

      try {
        await context.close();
      } catch {}
    }
  }

  async stop() {
    ++this.generation;

    this.active = false;
    this.starting = false;

    const session = this.session;
    this.session = null;

    this.stopMeter();
    this.flush();

    try {
      session?.close();
    } catch {}

    await this.cleanupAudio();

    this.emitMode('ended');
  }
}