// Per-viewer automatic quality. The converter exposes one rendition per quality,
// so instead of hls.js' built-in ABR we compare download speed with the media
// bitrate of each fragment and switch rendition when needed (unit tested).

export interface FragmentSample {
  bytes: number;
  loadMs: number; // time to download (includes on-the-fly transcoding)
  durationS: number; // media duration of the fragment
}

export interface AbrOptions {
  downRatio: number; // EWMA(throughput / media bitrate) below this → go down
  upRatio: number; // above this (sustained) → try going up
  minSamples: number;
  upHoldMs: number; // minimum time on a quality before going up
  downHoldMs: number;
  stallWindowMs: number;
}

const DEFAULTS: AbrOptions = {
  downRatio: 1.2,
  upRatio: 2.5,
  minSamples: 3,
  upHoldMs: 45_000,
  downHoldMs: 8_000,
  stallWindowMs: 60_000,
};

/** `ladder` is ordered best → worst (e.g. ['2160', '1080', '720', '480']). */
export class AutoQuality {
  private ratio: number | null = null;
  private samples = 0;
  private stalls: number[] = [];
  private lastSwitch: number;
  private index: number;
  private opts: AbrOptions;
  private ladder: string[];

  constructor(ladder: string[], start: string, now: number, opts: Partial<AbrOptions> = {}) {
    this.ladder = ladder;
    this.opts = { ...DEFAULTS, ...opts };
    this.index = Math.max(0, ladder.indexOf(start));
    this.lastSwitch = now;
  }

  get current() {
    return this.ladder[this.index];
  }

  private switchTo(index: number, now: number) {
    this.index = index;
    this.lastSwitch = now;
    this.ratio = null;
    this.samples = 0;
    return this.current;
  }

  /** Returns a new quality id when a switch is advised. */
  onFragment(s: FragmentSample, now: number): string | null {
    if (s.bytes < 10_000 || s.durationS <= 0 || s.loadMs <= 0) return null;
    const throughput = (s.bytes * 8) / (s.loadMs / 1000);
    const mediaBitrate = (s.bytes * 8) / s.durationS;
    const r = throughput / mediaBitrate;
    this.ratio = this.ratio === null ? r : this.ratio * 0.7 + r * 0.3;
    this.samples++;

    const held = now - this.lastSwitch;
    if (this.samples < this.opts.minSamples) return null;
    if (this.ratio < this.opts.downRatio && held > this.opts.downHoldMs && this.index < this.ladder.length - 1) {
      return this.switchTo(this.index + 1, now);
    }
    const recentStall = this.stalls.some((t) => now - t < this.opts.stallWindowMs * 1.5);
    if (
      this.ratio > this.opts.upRatio &&
      this.samples >= this.opts.minSamples * 2 &&
      held > this.opts.upHoldMs &&
      !recentStall &&
      this.index > 0
    ) {
      return this.switchTo(this.index - 1, now);
    }
    return null;
  }

  /** Two stalls within the window → go down right away. */
  onStall(now: number): string | null {
    this.stalls = this.stalls.filter((t) => now - t < this.opts.stallWindowMs);
    this.stalls.push(now);
    if (this.stalls.length >= 2 && this.index < this.ladder.length - 1 && now - this.lastSwitch > this.opts.downHoldMs) {
      this.stalls = [];
      return this.switchTo(this.index + 1, now);
    }
    return null;
  }
}
