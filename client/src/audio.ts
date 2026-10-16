import { localStorageGet, localStorageSet } from './storage.ts';
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
 * volume. Above, the video is routed once through a Web Audio GainNode; the
 * AudioContext is only created from a user gesture, so the sound is never routed
 * into a suspended (silent) context. Where video.volume is read-only (iOS), only
 * mute is offered: the phone's buttons set the volume, and routing MSE video
 * through Web Audio there has been known to go silent.
 */
export class Volume {
  pct: number;
  muted: boolean;
  /** 130 with Web Audio, else 100. */
  max: number;
  /** The slider does something (false on iOS: mute only). */
  readonly adjustable: boolean;
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};

  private video: HTMLVideoElement;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  /** Subtitle auto-sync listens to the sound: route it even at 100 % or less. */
  private analysisWanted = false;
  private routing = false;
  private readonly settable = volumeSettable();
  private readonly Ctx = audioContextCtor();

  constructor(video: HTMLVideoElement) {
    this.video = video;
    const saved = parseVolume(localStorageGet(VOLUME_KEY));
    this.max = this.Ctx && this.settable ? MAX_VOLUME : 100;
    this.pct = clampVolume(saved.pct, this.max);
    this.muted = saved.muted;
    this.adjustable = this.settable;
    this.apply();
  }

  get routed() {
    return !!this.gain;
  }

  private needsRoute() {
    return this.settable && (this.pct > 100 || this.analysisWanted);
  }

  /**
   * An analyser on the film's sound (for subtitle auto-sync), or null until a gesture
   * set up the route, or where routing is not done (iOS). Asking for it routes the sound
   * at the next gesture.
   */
  analyser(): AnalyserNode | null {
    if (!this.settable || !this.Ctx) return null;
    this.analysisWanted = true;
    if (!this.gain) {
      // Inside a click this still counts as the user's gesture.
      void this.route();
      return null;
    }
    if (!this.analyserNode && this.ctx && this.source) {
      // Before the gain: the level measured doesn't depend on this viewer's volume.
      const node = this.ctx.createAnalyser();
      node.fftSize = 2048;
      node.smoothingTimeConstant = 0.2;
      this.source.connect(node);
      this.analyserNode = node;
    }
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx?.state === 'running' ? this.analyserNode : null;
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
      this.source = source;
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
    // Routed: mute with the gain, so the analyser still hears the film.
    this.video.muted = this.muted && !this.gain;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(out.gain, this.ctx.currentTime, 0.015);
    this.onChange();
  }

  private save() {
    localStorageSet(VOLUME_KEY, JSON.stringify({ v: this.pct, m: this.muted }));
  }
}
