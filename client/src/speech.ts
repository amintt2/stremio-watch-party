// Voice activity of the film, measured on this viewer's own playback for subtitle
// auto-sync (subsync.ts). Nothing is recorded or sent anywhere: one number per tenth of
// a second of film, kept in memory for the media being watched.

export const SPEECH_STEP = 0.1;
/** Measurements kept, in steps (about 20 minutes of film). */
const MAX_SAMPLES = 12000;

/**
 * Voice-band level (300–3400 Hz) relative to the whole spectrum, in dB-ish units:
 * voices raise it, music and effects spread over all bands much less.
 */
export function voiceLevel(spectrum: Float32Array, sampleRate: number): number | null {
  const bin = sampleRate / 2 / spectrum.length;
  let voice = 0;
  let all = 0;
  for (let i = 1; i < spectrum.length; i++) {
    const db = spectrum[i];
    if (!Number.isFinite(db)) continue;
    const p = 10 ** (db / 10);
    all += p;
    const f = i * bin;
    if (f >= 300 && f <= 3400) voice += p;
  }
  if (all <= 1e-10) return null; // silence: says nothing
  return 10 * Math.log10(voice + 1e-12) * 0.5 + 10 * Math.log10(voice / all + 1e-6) * 0.5;
}

export class SpeechMeter {
  /** Step index (video time / SPEECH_STEP) → level. */
  readonly samples = new Map<number, number>();
  private timer: number | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;

  private readonly video: HTMLVideoElement;
  private readonly analyser: () => AnalyserNode | null;

  constructor(video: HTMLVideoElement, analyser: () => AnalyserNode | null) {
    this.video = video;
    this.analyser = analyser;
  }

  start() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.measure(), SPEECH_STEP * 1000);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** New media: what was heard belongs to the previous one. */
  reset() {
    this.samples.clear();
  }

  /** Seconds of film heard so far. */
  get heard() {
    return this.samples.size * SPEECH_STEP;
  }

  private measure() {
    const v = this.video;
    if (v.paused || v.seeking || v.readyState < 3 || Math.abs(v.playbackRate - 1) > 0.01) return;
    const node = this.analyser();
    if (!node) return;
    if (!this.buffer || this.buffer.length !== node.frequencyBinCount) this.buffer = new Float32Array(node.frequencyBinCount);
    node.getFloatFrequencyData(this.buffer);
    const level = voiceLevel(this.buffer, node.context.sampleRate);
    if (level === null) return;
    this.samples.set(Math.round(v.currentTime / SPEECH_STEP), level);
    if (this.samples.size > MAX_SAMPLES) {
      // Forget what is farthest from where we are now.
      const here = v.currentTime / SPEECH_STEP;
      let far = -1;
      let farKey = 0;
      for (const k of this.samples.keys()) {
        const d = Math.abs(k - here);
        if (d > far) {
          far = d;
          farKey = k;
        }
      }
      this.samples.delete(farKey);
    }
  }
}
