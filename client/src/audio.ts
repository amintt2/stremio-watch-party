import { localStorageGet, localStorageSet } from './auth.ts';
import { clampVolume, MAX_VOLUME, parseVolume, volumeOutput } from './controls.ts';

const VOLUME_KEY = 'wp-volume';

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  return window.AudioContext || (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext || null;
}

/** iOS ignores video.volume (always 1): only Web Audio or mute work there. */
function volumeSettable() {
  try {
    const probe = document.createElement('video');
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
}

/**
 * This viewer's volume, 0–130 % (never synced). Up to 100 % it is the element's own
 * volume. Above (or on iOS, anything but 100 %), the video is routed once through a
 * Web Audio GainNode; the AudioContext is only created from a user gesture, so the
 * sound is never routed into a suspended (silent) context.
 */
export class Volume {
  pct: number;
  muted: boolean;
  /** 130 with Web Audio, else 100. */
  max: number;
  /** The slider does something (false on iOS without Web Audio: mute only). */
  readonly adjustable: boolean;
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};

  private video: HTMLVideoElement;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private routing = false;
  private readonly settable = volumeSettable();
  private readonly Ctx = audioContextCtor();

  constructor(video: HTMLVideoElement) {
    this.video = video;
    const saved = parseVolume(localStorageGet(VOLUME_KEY));
    this.max = this.Ctx ? MAX_VOLUME : 100;
    this.pct = clampVolume(saved.pct, this.max);
    this.muted = saved.muted;
    this.adjustable = this.settable || !!this.Ctx;
    this.apply();
  }

  get routed() {
    return !!this.gain;
  }

  /** What the viewer actually hears right now (100 % until a gesture allows the boost). */
  get effective() {
    return this.routed ? this.pct : Math.min(this.pct, 100);
  }

  private needsRoute() {
    return this.pct > 100 || (!this.settable && this.pct !== 100);
  }

  set(pct: number) {
    this.pct = clampVolume(pct, this.max);
    if (this.pct > 0) this.muted = false;
    this.save();
    this.apply();
    this.gesture();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (!this.muted && this.pct === 0) this.pct = 50;
    this.save();
    this.apply();
    this.gesture();
  }

  /**
   * Call from user gestures: resumes a suspended context, or sets up the gain route
   * when the saved volume needs it.
   */
  gesture() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (!this.gain && this.needsRoute()) void this.route();
  }

  private async route() {
    if (this.routing || this.gain || !this.Ctx) return;
    this.routing = true;
    try {
      const ctx = new this.Ctx();
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') {
        // Never route the sound into a context that would stay silent.
        ctx.close().catch(() => {});
        this.routing = false;
        return;
      }
      const source = ctx.createMediaElementSource(this.video);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
    } catch {
      this.max = 100;
      this.pct = Math.min(this.pct, 100);
      this.save();
      this.onError('Volume au-delà de 100 % indisponible sur cet appareil');
    }
    this.routing = false;
    this.apply();
  }

  private apply() {
    const out = volumeOutput(this.pct, this.muted, this.routed);
    try {
      if (this.settable) this.video.volume = out.element;
    } catch {
      /* read-only */
    }
    this.video.muted = this.muted;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(out.gain, this.ctx.currentTime, 0.015);
    this.onChange();
  }

  private save() {
    localStorageSet(VOLUME_KEY, JSON.stringify({ v: this.pct, m: this.muted }));
  }
}
