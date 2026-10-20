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
  /** A slow download only matters when the buffer ahead is thinner than this (seconds). */
  lowBufferS: number;
  /** Going down this soon after going up: the higher quality doesn't hold, wait longer next time. */
  flapWindowMs: number;
  maxUpHoldMs: number;
}

const DEFAULTS: AbrOptions = {
  downRatio: 1.2,
  upRatio: 2.5,
  minSamples: 3,
  upHoldMs: 45_000,
  downHoldMs: 8_000,
  stallWindowMs: 60_000,
  lowBufferS: 10,
  flapWindowMs: 120_000,
  maxUpHoldMs: 10 * 60_000,
};

/** What the player knows when a fragment arrives (both optional: unknown = old behaviour). */
export interface AbrContext {
  /** Seconds buffered ahead of what is on screen. */
  ahead?: number;
  /**
   * Whether a switch up may happen now. Every switch reloads the stream (a cut), so the
   * player only allows it at a natural break (pause, seek, nothing played yet); otherwise
   * the switch waits for the next break (see atBreak).
   */
  upNow?: boolean;
}

/** `ladder` is ordered best → worst (e.g. ['2160', '1080', '720', '480']). */
export class AutoQuality {
  private ratio: number | null = null;
  private samples = 0;
  private stalls: number[] = [];
  private lastSwitch: number;
  private index: number;
  private opts: AbrOptions;
  private ladder: string[];
  /** Time on a quality before going up; doubles each time a quality up didn't hold. */
  private upHold: number;
  private lastUp = -Infinity;
  /** The conditions to go up were met while it wasn't allowed: done at the next break. */
  private upReady = false;

  constructor(ladder: string[], start: string, now: number, opts: Partial<AbrOptions> = {}) {
    this.ladder = ladder;
    this.opts = { ...DEFAULTS, ...opts };
    this.index = Math.max(0, ladder.indexOf(start));
    this.lastSwitch = now;
    this.upHold = this.opts.upHoldMs;
  }

  /** A switch up is waiting for the next break. */
  get upPending() {
    return this.upReady && this.index > 0;
  }

  get current() {
    return this.ladder[this.index];
  }

  private switchTo(index: number, now: number) {
    if (index > this.index && now - this.lastUp < this.opts.flapWindowMs) {
      // Up, then down again soon: that quality doesn't hold here, try it less often.
      this.upHold = Math.min(this.upHold * 2, this.opts.maxUpHoldMs);
    }
    if (index < this.index) this.lastUp = now;
    this.upReady = false;
    this.index = index;
    this.lastSwitch = now;
    this.ratio = null;
    this.samples = 0;
    return this.current;
  }

  /** Returns a new quality id when a switch is advised. */
  onFragment(s: FragmentSample, now: number, ctx: AbrContext = {}): string | null {
    if (s.bytes < 10_000 || s.durationS <= 0 || s.loadMs <= 0) return null;
    const throughput = (s.bytes * 8) / (s.loadMs / 1000);
    const mediaBitrate = (s.bytes * 8) / s.durationS;
    const r = throughput / mediaBitrate;
    this.ratio = this.ratio === null ? r : this.ratio * 0.7 + r * 0.3;
    this.samples++;

    const held = now - this.lastSwitch;
    if (this.samples < this.opts.minSamples) return null;
    if (this.ratio < this.opts.downRatio && held > this.opts.downHoldMs && this.index < this.ladder.length - 1 && this.short(ctx.ahead)) {
      return this.switchTo(this.index + 1, now);
    }
    const recentStall = this.stalls.some((t) => now - t < this.opts.stallWindowMs * 1.5);
    const up =
      this.ratio > this.opts.upRatio &&
      this.samples >= this.opts.minSamples * 2 &&
      held > this.upHold &&
      !recentStall &&
      this.index > 0;
    if (!up) {
      if (this.ratio < this.opts.upRatio) this.upReady = false;
      return null;
    }
    if (ctx.upNow === false) {
      this.upReady = true;
      return null;
    }
    return this.switchTo(this.index - 1, now);
  }

  /**
   * Download slower than the bitrate margin: going down (a reload) is only worth it when
   * the buffer won't carry playback: thin already, or draining to empty within a minute.
   */
  private short(ahead: number | undefined) {
    if (ahead === undefined || ahead < this.opts.lowBufferS) return true;
    const r = this.ratio ?? 1;
    return r < 1 && ahead / (1 - r) < 60;
  }

  /** At a natural break (pause, seek): the switch up that was waiting, if any. */
  atBreak(now: number): string | null {
    if (!this.upPending) return null;
    if (this.stalls.some((t) => now - t < this.opts.stallWindowMs * 1.5)) {
      this.upReady = false;
      return null;
    }
    return this.switchTo(this.index - 1, now);
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
