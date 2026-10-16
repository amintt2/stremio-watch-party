import Hls from 'hls.js';
import type { RoomMedia, RoomState } from './api.ts';
import { AutoQuality } from './abr.ts';
import type { Connection } from './connection.ts';
import { localStorageGet, localStorageSet } from './auth.ts';
import { correction, expectedPosition, SEEK_THRESHOLD } from './sync.ts';
import { pickAudioTrack } from './format.ts';
import { bufferedAhead, bufferHealth, catchUpTarget, ewma, fragmentRatio, MAX_LEAD_S, type Health } from './health.ts';

const TICK_MS = 250;
const STALL_REPORT_MS = 800;
const PREF_KEY = 'wp-quality';
/** "fr" (VF) or "vo": this viewer's audio language, applied to every new media. */
const AUDIO_KEY = 'wp-audio';

export interface Caps {
  hevc: boolean;
  av1: boolean;
  vp9: boolean;
}

/**
 * What this browser decodes in fMP4 besides H.264/AAC. Sources in these codecs are
 * copied instead of transcoded (e.g. 4K HEVC 10-bit on Discord desktop with a recent GPU).
 */
export function detectCaps(): Caps {
  const MS: typeof MediaSource | undefined =
    window.MediaSource || (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  const ok = (type: string) => !!MS && MS.isTypeSupported(type);
  return {
    hevc: ok('video/mp4; codecs="hvc1.2.4.L153.B0"') || ok('video/mp4; codecs="hev1.2.4.L153.B0"'),
    av1: ok('video/mp4; codecs="av01.0.12M.10"'),
    vp9: ok('video/mp4; codecs="vp09.02.51.10"'),
  };
}

/** Path segment understood by the server: quality id + capability letters. */
export function profileSegment(quality: string, caps: Caps) {
  return `${quality}${caps.hevc ? 'h' : ''}${caps.av1 ? 'a' : ''}${caps.vp9 ? 'v' : ''}`;
}

export interface Track {
  id: number;
  label: string;
}

/**
 * Drives the <video> element from the room state: loads the HLS rendition for this
 * viewer's quality, keeps it within ~0.1 s of the room, reports stalls/readiness and
 * picks the quality automatically.
 */
export class Player {
  readonly caps = detectCaps();
  /** Current rendition id (e.g. "1080"). */
  quality: string | null = null;
  /** "auto" or a fixed quality id. */
  preference: string = localStorageGet(PREF_KEY) || 'auto';
  audioTracks: Track[] = [];
  subtitleTracks: Track[] = [];
  audioTrack = 0;
  audioPref: string | null = localStorageGet(AUDIO_KEY);
  private audioPicked = false;
  subtitleTrack = -1;
  needsGesture = false;
  error: string | null = null;

  onChange: () => void = () => {};

  private hls: Hls | null = null;
  private media: RoomMedia | null = null;
  private state: RoomState | null = null;
  private abr: AutoQuality | null = null;
  private pendingReady = false;
  private reportedStall = false;
  private stallSince = 0;
  private graceUntil = 0;
  private hasPlayed = false;
  private fatalCount = 0;
  /** EWMA of segment download speed / media bitrate, on the current quality. */
  private ratio: number | null = null;
  /** Catch-up jump in progress: when it started, and whether we wait for the room there. */
  private catchUpAt = 0;
  private holding = false;
  private latencyPending = false;
  /** How long jumps outside the buffer take to load (s), measured. */
  private seekLatency = 2;
  private video: HTMLVideoElement;
  private conn: Connection;

  constructor(video: HTMLVideoElement, conn: Connection) {
    this.video = video;
    this.conn = conn;
    setInterval(() => this.tick(), TICK_MS);
  }

  /** This viewer's own position (what is on screen), or the room's before loading. */
  localPosition() {
    return this.media && this.video.readyState >= 1 ? this.video.currentTime : this.expected();
  }

  private ranges(): [number, number][] {
    const b = this.video.buffered;
    const out: [number, number][] = [];
    for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
    return out;
  }

  /** Seconds buffered ahead of what is on screen. */
  bufferAhead() {
    return bufferedAhead(this.ranges(), this.video.currentTime);
  }

  /** Buffered ranges as [start, end] in seconds (for the seek bar). */
  bufferedRanges() {
    return this.ranges();
  }

  /** Green / orange / red, from the buffer ahead and the download speed. */
  health(): Health {
    const duration = this.media?.duration || Infinity;
    return bufferHealth({ ahead: this.bufferAhead(), ratio: this.ratio, left: duration - this.video.currentTime });
  }

  get downloadRatio() {
    return this.ratio;
  }

  /** True while this viewer is jumping to (or waiting for) the room position. */
  get catchingUp() {
    const s = this.state;
    if (!s?.media || !this.media) return false;
    if (this.holding || this.latencyPending) return true;
    return s.running && this.video.readyState >= 1 && Math.abs(this.video.currentTime - this.expected()) > SEEK_THRESHOLD;
  }

  get ladder() {
    return this.media?.qualities.map((q) => q.id) || [];
  }

  /** Room position right now, from the server clock. */
  expected() {
    const s = this.state;
    if (!s?.media) return 0;
    return expectedPosition({ ...s, duration: s.media.duration }, this.conn.clock.now());
  }

  applyState(state: RoomState) {
    const prev = this.state;
    this.state = state;
    if (!state.media) {
      if (this.media) this.unload();
      return;
    }
    if (state.media.sid !== this.media?.sid) {
      this.load(state.media);
      return;
    }
    // Someone seeked: jump now, without grace, so our buffering holds the room
    // until everybody has the new position ready.
    if (prev && state.rev !== prev.rev && Math.abs(this.video.currentTime - this.expected()) > SEEK_THRESHOLD) {
      this.video.currentTime = this.expected();
    }
  }

  private initialQuality(): string {
    const ladder = this.ladder;
    if (this.preference !== 'auto') {
      // Closest rung at or below the preferred one.
      const pref = Number(this.preference);
      return ladder.find((id) => Number(id) <= pref) || ladder[ladder.length - 1];
    }
    return ladder.includes('1080') ? '1080' : ladder[0];
  }

  private load(media: RoomMedia) {
    this.media = media;
    this.hasPlayed = false;
    this.ratio = null;
    this.catchUpAt = 0;
    this.holding = false;
    this.latencyPending = false;
    this.pendingReady = true;
    this.reportedStall = false;
    this.audioTrack = 0;
    this.audioPicked = false;
    this.subtitleTrack = -1;
    const start = this.initialQuality();
    this.abr = this.preference === 'auto' ? new AutoQuality(this.ladder, start, Date.now()) : null;
    this.startHls(start, this.expected());
  }

  private unload() {
    this.hls?.destroy();
    this.hls = null;
    this.media = null;
    this.quality = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.onChange();
  }

  private startHls(quality: string, startPosition: number) {
    const media = this.media;
    if (!media) return;
    this.hls?.destroy();
    this.hls = null;
    this.error = null;
    this.quality = quality;
    this.conn.send({ t: 'quality', value: quality });

    const url = `/api/hls/${media.sid}/${profileSegment(quality, this.caps)}/master.m3u8`;

    if (!Hls.isSupported()) {
      // iOS < 17.1 WebView: native HLS.
      this.video.src = url;
      this.video.addEventListener('loadedmetadata', () => (this.video.currentTime = startPosition), { once: true });
      this.onChange();
      return;
    }

    // Generous timeouts: the first segment of a torrent or a 4K transcode can take a while.
    const slow = {
      default: {
        maxTimeToFirstByteMs: 45_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
      },
    };
    const hls = new Hls({
      startPosition,
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      backBufferLength: 60,
      manifestLoadPolicy: slow,
      playlistLoadPolicy: slow,
      fragLoadPolicy: slow,
    });
    this.hls = hls;

    hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      if (data.frag.type !== 'main') return;
      const { loaded, loading } = data.frag.stats;
      const r = fragmentRatio(loaded, loading.end - loading.start, data.frag.duration);
      if (r !== null) this.ratio = ewma(this.ratio, r);
      if (!this.abr) return;
      const next = this.abr.onFragment(
        { bytes: loaded, loadMs: loading.end - loading.start, durationS: data.frag.duration },
        Date.now()
      );
      if (next) this.switchQuality(next);
    });
    const updateTracks = () => {
      this.audioTracks = hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Piste ${i + 1}` }));
      // First time this media's tracks are known: apply the viewer's VF / VO choice.
      if (!this.audioPicked && hls.audioTracks.length) {
        this.audioPicked = true;
        const wanted = pickAudioTrack(hls.audioTracks, this.audioPref);
        if (wanted !== null && wanted !== this.audioTrack) {
          this.audioTrack = wanted;
          hls.audioTrack = wanted;
        }
      }
      this.subtitleTracks = hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Sous-titres ${i + 1}` }));
      this.onChange();
    };
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.fatalCount = 0;
      updateTracks();
      if (this.audioTrack > 0 && this.audioTrack < hls.audioTracks.length) hls.audioTrack = this.audioTrack;
      if (this.subtitleTrack >= 0) hls.subtitleTrack = this.subtitleTrack;
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, updateTracks);
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, updateTracks);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      this.fatalCount++;
      if (this.fatalCount > 4) {
        this.error = 'La lecture a échoué. Essaie une qualité plus basse ou une autre source.';
        this.onChange();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(this.expected());
      else this.startHls(quality, this.expected());
    });

    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.onChange();
  }

  private switchQuality(quality: string) {
    if (quality === this.quality) return;
    this.graceUntil = Date.now() + 8000;
    this.ratio = null;
    this.holding = false;
    this.startHls(quality, this.expected());
  }

  /** "auto" or a quality id, chosen in the UI. */
  setPreference(pref: string) {
    this.preference = pref;
    localStorageSet(PREF_KEY, pref);
    if (!this.media) return;
    if (pref === 'auto') {
      this.abr = new AutoQuality(this.ladder, this.quality || this.initialQuality(), Date.now());
      this.onChange();
    } else {
      this.abr = null;
      this.switchQuality(pref);
    }
  }

  setAudioTrack(id: number) {
    this.audioTrack = id;
    if (this.hls) {
      this.hls.audioTrack = id;
      // Remember the choice as a language, so the next film starts in it too.
      const tracks = this.hls.audioTracks;
      if (tracks.length > 1) {
        this.audioPref = pickAudioTrack(tracks, 'fr') === id ? 'fr' : 'vo';
        localStorageSet(AUDIO_KEY, this.audioPref);
      }
    }
    this.onChange();
  }

  setSubtitleTrack(id: number) {
    this.subtitleTrack = id;
    if (this.hls) {
      this.hls.subtitleTrack = id;
      this.hls.subtitleDisplay = id >= 0;
    }
    this.onChange();
  }

  /** Called from a click when the browser blocked autoplay. */
  unlock() {
    this.needsGesture = false;
    this.video.play().catch(() => {});
    this.onChange();
  }

  private send(value: boolean) {
    this.conn.send({ t: 'buffering', value });
  }

  private tick() {
    const s = this.state;
    const v = this.video;
    if (!s?.media || !this.media) return;
    const now = Date.now();
    const expected = this.expected();

    // Load barrier: tell the room we can play at the expected position.
    if (this.pendingReady && v.readyState >= 3 && !v.seeking) {
      this.pendingReady = false;
      this.send(false);
    }

    // A catch-up jump outside the buffer finished loading: remember how long it took.
    if (this.latencyPending && v.readyState >= 3 && !v.seeking) {
      this.latencyPending = false;
      this.seekLatency = Math.min(MAX_LEAD_S, ewma(this.seekLatency, (now - this.catchUpAt) / 1000, 0.5));
    }

    if (s.running) {
      // Landed ahead of the room after a catch-up jump: wait there (paused) until the
      // room position reaches us, instead of jumping again.
      if (this.holding && !v.seeking && v.readyState >= 3) {
        const lead = v.currentTime - expected;
        if (lead > 0.05 && lead < MAX_LEAD_S + 1) {
          if (!v.paused) v.pause();
        } else this.holding = false;
      }
    }

    if (s.running && !(this.holding && v.paused)) {
      if (v.paused && !this.needsGesture && v.readyState >= 2) {
        v.play().catch((err: DOMException) => {
          if (err.name === 'NotAllowedError') {
            this.needsGesture = true;
            this.onChange();
          }
        });
      }
      if (!v.seeking && v.readyState >= 2) {
        const c = correction(v.currentTime, expected);
        // While the previous catch-up jump is still loading, let it finish instead of
        // chasing the room clock with jump after jump.
        const loadingJump = (this.latencyPending || this.holding) && v.readyState < 3 && now < this.graceUntil;
        if (c.seekTo !== undefined && !loadingJump) {
          const target = catchUpTarget(expected, this.ranges(), this.seekLatency);
          v.currentTime = target.position;
          this.holding = target.lead > 0;
          this.latencyPending = target.lead > 0;
          this.catchUpAt = now;
          // Our own catch-up seek must not hold the whole room.
          this.graceUntil = now + 4000;
          this.onChange();
        }
        if (v.playbackRate !== c.rate) v.playbackRate = c.rate;
      }

      const stalled = !v.paused && v.readyState < 3;
      if (stalled && this.hasPlayed && now > this.graceUntil) {
        if (!this.stallSince) this.stallSince = now;
        else if (now - this.stallSince > STALL_REPORT_MS && !this.reportedStall) {
          this.reportedStall = true;
          this.send(true);
          const next = this.abr?.onStall(now);
          if (next) this.switchQuality(next);
        }
      } else {
        this.stallSince = 0;
      }
      if (!stalled && !v.paused && v.currentTime > 1) this.hasPlayed = true;
    } else if (!s.running) {
      this.holding = false;
      if (!v.paused) v.pause();
      if (v.playbackRate !== 1) v.playbackRate = 1;
      if (!v.seeking && v.readyState >= 1 && Math.abs(v.currentTime - expected) > 0.25) v.currentTime = expected;
    }

    if (this.reportedStall && v.readyState >= 3 && !v.seeking) {
      this.reportedStall = false;
      this.send(false);
    }
  }
}
