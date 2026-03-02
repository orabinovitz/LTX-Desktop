/**
 * PCM audio playback queue using Web Audio API.
 *
 * Accepts 24kHz mono Int16 PCM chunks from the Gemini Live API and
 * schedules them for gapless playback via AudioBufferSourceNode chaining.
 */

const SAMPLE_RATE = 24000;

export class AudioPlaybackQueue {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private gainNode: GainNode | null = null;

  start(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);
    this.nextStartTime = 0;
  }

  enqueue(pcmBase64: string): void {
    if (!this.ctx || !this.gainNode) return;

    const raw = atob(pcmBase64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const buffer = this.ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);

    const now = this.ctx.currentTime;
    const scheduleAt = Math.max(now, this.nextStartTime);
    source.start(scheduleAt);
    this.nextStartTime = scheduleAt + buffer.duration;
  }

  flush(): void {
    if (!this.ctx || !this.gainNode) return;

    this.gainNode.disconnect();
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);
    this.nextStartTime = 0;
  }

  stop(): void {
    if (!this.ctx) return;
    this.flush();
    this.ctx.close().catch(() => {});
    this.ctx = null;
    this.gainNode = null;
  }

  get playing(): boolean {
    if (!this.ctx) return false;
    return this.ctx.currentTime < this.nextStartTime;
  }
}
