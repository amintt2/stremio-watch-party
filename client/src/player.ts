import Hls from 'hls.js';
import type { RoomMedia, RoomState } from './api.ts';
import { AutoQuality } from './abr.ts';
import type { Connection } from './connection.ts';
import { localStorageGet, localStorageSet } from './auth.ts';
import { expectedPosition } from './sync.ts';
import { pickAudioTrack, audioChipLabel, langCode, trackLabel } from './format.ts';
import { bufferedAhead, bufferHealth, ewma, fragmentRatio, type Health } from './health.ts';
import { cachedCaps, markBroken, outputOf, probeCaps, type Caps, type Codec } from './codecprobe.ts';

export type { Caps } from './codecprobe.ts';

const TICK_MS = 250;
const STALL_REPORT_MS = 800;
/** Behind the live by more than this: "Revenir au direct" is offered (same as the server). */
export const BEHIND_S = 4;
/** Where this viewer is, told to the room this often (who is behind, when the film is over). */
const POSITION_EVERY_MS = 5000;
const PREF_KEY = 'wp-quality';
/** "fr" (VF) or "vo": this viewer's audio language, applied to every new media. */
const AUDIO_KEY = 'wp-audio';
/** The exact language of the last audio track chosen ("en"), tried before fr / vo. */
const AUDIO_LANG_KEY = 'wp-audio-lang';

/** Seconds the time may run without a single new picture before we call it a black screen. */
const NO_PICTURE_S = 4;
/** No video at all after this long: reload (then a lower quality). */
const LOAD_RETRY_MS = 30_000;
const NO_PICTURE = "La vidéo ne s'affiche pas sur cet appareil. Essaie une qualité plus basse ou une autre source.";


/** Path segment understood by the server: quality id + capability letters. */
export function profileSegment(quality: string, caps: Caps) {
  return `${quality}${caps.hevc ? 'h' : ''}${caps.av1 ? 'a' : ''}${caps.vp9 ? 'v' : ''}`;
}

export interface Track {
  id: number;
  label: string;
  /** Short chip label ("VF", "EN"), audio tracks only. */
  short?: string;
  /** Language code from the file ("fr", "en"), when it says. */
  lang?: string;
}

/**
 * Drives the <video> element from the room state: loads the HLS rendition for this
 * viewer's quality, reports readiness and picks the quality automatically.
 *
 * Sync works like a live stream: the room's position is the live. Everyone starts there;
 * then each viewer plays at their own pace (no speed change, no jump): one who stalls
 * falls behind and is offered to go back to the live (goLive), or stays behind. Pause,
 * play and seeks from the room apply to everyone (pause: where each one is).
 */
export class Player {
  /** Codecs this device really decodes (codecprobe.ts); until tested, only H.264. */
  caps: Caps = cachedCaps();
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
  /** Playing in an external player or on the site (see externalPlayer.ts): nothing plays here. */
  detached = false;

  onChange: () => void = () => {};

  private hls: Hls | null = null;
  private media: RoomMedia | null = null;
  private state: RoomState | null = null;
  private abr: AutoQuality | null = null;
  private pendingReady = false;
  /** This viewer's uid. */
  uid: string | null = null;
  private stallSince = 0;
  private stalled = false;
  private graceUntil = 0;
  private hasPlayed = false;
  /** Last room jump followed (new film, seek). */
  private seekId: number | undefined;
  /** A room jump arrived while nothing was loaded (reload): applied once something is. */
  private pendingSeek = false;
  /** This load already started at the live (arrival mid-film). */
  private joinedLive = false;
  private lastPositionSent = 0;
  private fatalCount = 0;
  private lastFatalAt = 0;
  /** Since when nothing can be shown (readyState < 2), for the loading overlay. */
  private notReadySince = 0;
  /** EWMA of segment download speed / media bitrate, on the current quality. */
  private ratio: number | null = null;
  private video: HTMLVideoElement;
  private conn: Connection;
  /** Black-screen watch: decoded pictures, and where the time was when the count last moved. */
  private frames = -1;
  private framesTime = 0;
  /** When this load started, and why it is still loading (for the statistics). */
  loadStartedAt = 0;
  /** Set when the picture failed and we switched to H.264 (shown in the statistics). */
  fallback: string | null = null;
  /** When the viewer's audio track was put back after hls.js switched away from it. */
  private audioRestores: number[] = [];
  /** Automatic reloads of this media because nothing came (see watchLoading). */
  private loadRetries = 0;

  constructor(video: HTMLVideoElement, conn: Connection) {
    this.video = video;
    this.conn = conn;
    setInterval(() => this.tick(), TICK_MS);
    probeCaps()
      .then((caps) => this.setCaps(caps))
      .catch(() => {});
  }

  /** New codec test result: reload the stream if it changes what this viewer receives. */
  private setCaps(caps: Caps) {
    const before = this.output();
    this.caps = caps;
    const after = this.output();
    if (this.quality && before && after && (before.mode !== after.mode || before.codec !== after.codec)) {
      this.startHls(this.quality, this.localPosition());
    }
    this.onChange();
  }

  /** What the server sends for the current quality: copy of the source or H.264. */
  output() {
    const q = this.media?.qualities.find((x) => x.id === this.quality);
    if (!this.media || !q) return null;
    return outputOf(this.media.source, q.maxWidth, this.caps);
  }

  /** Decoded pictures so far (null where the browser doesn't tell). */
  decodedFrames(): number | null {
    const q = this.video.getVideoPlaybackQuality?.();
    return q ? q.totalVideoFrames : null;
  }

  droppedFrames(): number | null {
    const q = this.video.getVideoPlaybackQuality?.();
    return q ? q.droppedVideoFrames : null;
  }

  /**
   * The picture does not come (codec announced but not really decoded here): stop copying
   * this codec on this device and reload in H.264. Returns false when it was H.264 already.
   */
  private pictureFailed(reason: string) {
    const out = this.output();
    if (!out || out.mode !== 'copy' || out.codec === 'h264' || !this.quality) return false;
    const codec = out.codec as Codec;
    markBroken(codec);
    this.caps = { ...this.caps, [codec]: false };
    this.fallback = `${codec.toUpperCase()} non affiché ici (${reason}) : passage en H.264`;
    this.startHls(this.quality, this.localPosition());
    return true;
  }

  /** This viewer's own position (what is on screen), or the room's before loading. */
  localPosition() {
    if (this.pendingSeek) return this.expected();
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

  /** Seconds this viewer is behind the live (0 when at it, or before anything plays). */
  behind() {
    if (!this.state?.media || !this.media || this.detached || this.video.readyState < 1 || this.video.ended) return 0;
    return Math.max(0, this.expected() - this.video.currentTime);
  }

  /** "Revenir au direct": jump to where the room is. */
  goLive() {
    if (!this.media || this.video.readyState < 1) return;
    this.video.currentTime = this.expected();
    this.afterJump();
    this.onChange();
  }

  /** After a jump: not a stall for the automatic quality, and tell the room soon. */
  private afterJump() {
    const now = Date.now();
    this.graceUntil = now + 4000;
    this.lastPositionSent = now - POSITION_EVERY_MS + 1500;
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
    if (this.detached) {
      // Back on the site later: only the jumps from then on count.
      this.seekId = state.seekId;
      return;
    }
    if (!state.media) {
      if (this.media) this.unload();
      return;
    }
    if (state.media.sid !== this.media?.sid) {
      this.seekId = state.seekId;
      this.load(state.media);
      return;
    }
    // A GPU encoder took over (or left): same film, reload the stream from where the room is.
    // Only viewers who get a conversion: a copy of the source does not go through the GPU.
    if ((state.media.encoder?.by || null) !== (this.media.encoder?.by || null)) {
      this.media = state.media;
      if (this.quality && this.output()?.mode === 'transcode') this.startHls(this.quality, this.localPosition());
    }
    // Someone seeked: everyone goes there, those behind the live too. Other changes
    // (pause, play, people coming) leave each viewer where they are.
    const seeked = state.seekId !== undefined ? state.seekId !== this.seekId : !!prev && state.rev !== prev.rev && state.position !== prev.position && !state.running;
    this.seekId = state.seekId;
    if (seeked && this.video.readyState < 1) this.pendingSeek = true;
    else if (seeked && Math.abs(this.video.currentTime - this.expected()) > 0.5) {
      this.video.currentTime = this.expected();
      this.afterJump();
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
    this.joinedLive = false;
    this.pendingSeek = false;
    this.ratio = null;
    this.pendingReady = true;
    this.lastPositionSent = 0;
    this.audioTrack = 0;
    this.audioPicked = false;
    this.loadRetries = 0;
    this.fatalCount = 0;
    this.fallback = null;
    this.subtitleTrack = -1;
    const start = this.initialQuality();
    this.abr = this.preference === 'auto' ? new AutoQuality(this.ladder, start, Date.now()) : null;
    this.startHls(start, this.expected());
  }

  /** Stops (true) or resumes (false) playing here, the room going on either way. */
  setDetached(on: boolean) {
    if (on === this.detached) return;
    this.detached = on;
    if (on) {
      this.pendingReady = false;
      if (this.media) this.unload();
    } else if (this.state?.media) {
      this.seekId = this.state.seekId;
      this.load(this.state.media);
    }
    this.onChange();
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
    this.frames = -1;
    this.loadStartedAt = Date.now();
    this.notReadySince = this.loadStartedAt;
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
      this.audioTracks = hls.audioTracks.map((t, i) => ({ id: i, label: trackLabel(t, `Piste ${i + 1}`), short: audioChipLabel(t, i) }));
      // First time this media's tracks are known: apply the viewer's VF / VO choice.
      if (!this.audioPicked && hls.audioTracks.length) {
        this.audioPicked = true;
        const wanted = pickAudioTrack(hls.audioTracks, this.audioPref, localStorageGet(AUDIO_LANG_KEY));
        if (wanted !== null && wanted !== this.audioTrack) {
          this.audioTrack = wanted;
          hls.audioTrack = wanted;
        }
      }
      this.subtitleTracks = hls.subtitleTracks.map((t, i) => ({ id: i, label: trackLabel(t, `Sous-titres ${i + 1}`), lang: t.lang || undefined }));
      this.onChange();
    };
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // Cues load into a hidden track: the stage draws them in the viewer's style.
      hls.subtitleDisplay = false;
      updateTracks();
      // A reload (quality, retry) keeps the viewer's track, the first one too: the file may
      // mark another track as default.
      if (this.audioTrack >= 0 && this.audioTrack < hls.audioTracks.length && hls.audioTrack !== this.audioTrack) hls.audioTrack = this.audioTrack;
      if (this.subtitleTrack >= 0) hls.subtitleTrack = this.subtitleTrack;
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, updateTracks);
    // hls.js changes track by itself when the chosen one fails to load for a moment: go
    // back to the viewer's (a few times a minute at most, then accept and say so).
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, data) => {
      if (this.hls !== hls || data.id === this.audioTrack || this.audioTrack >= hls.audioTracks.length) return;
      const now = Date.now();
      this.audioRestores = this.audioRestores.filter((t) => now - t < 60_000);
      if (this.audioRestores.length < 3) {
        this.audioRestores.push(now);
        const wanted = this.audioTrack;
        setTimeout(() => {
          if (this.hls === hls && this.audioTrack === wanted && hls.audioTrack !== wanted) hls.audioTrack = wanted;
        }, 2000);
      } else {
        const lost = this.audioTracks[this.audioTrack]?.label;
        this.audioTrack = data.id;
        this.fallback = `Piste audio « ${lost || '?'} » indisponible : passage en « ${this.audioTracks[data.id]?.label || '?'} »`;
        this.onChange();
      }
    });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, updateTracks);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      // A copied HEVC/AV1/VP9 the device can't take: H.264 right away, no retry loop. Only
      // errors of the video track (audio is AAC for everyone and says nothing about this).
      const videoRefused =
        data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
        ((data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR || data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR) &&
          (data.sourceBufferName === 'video' || data.sourceBufferName === 'audiovideo'));
      if (videoRefused && this.pictureFailed('vidéo refusée par le décodeur')) return;
      if (!data.fatal) return;
      // Counted over a minute: a film that hiccups once an hour must not end in an error.
      const now = Date.now();
      if (now - this.lastFatalAt > 60_000) this.fatalCount = 0;
      this.lastFatalAt = now;
      this.fatalCount++;
      if (this.fatalCount > 4) {
        this.error = `La lecture a échoué (${data.details}). Essaie une qualité plus basse ou une autre source.`;
        this.onChange();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(this.localPosition());
      else this.startHls(quality, this.localPosition());
    });

    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.onChange();
  }

  private switchQuality(quality: string) {
    if (quality === this.quality) return;
    this.graceUntil = Date.now() + 8000;
    this.ratio = null;
    // Same picture, another quality: from where this viewer is, not from the live.
    this.startHls(quality, this.localPosition());
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
      // The closest quality this film has (4K asked, 1080p at most here).
      this.switchQuality(this.initialQuality());
    }
  }

  setAudioTrack(id: number) {
    this.audioTrack = id;
    if (this.hls) {
      this.hls.audioTrack = id;
      // Remember the choice as a language, so the next film starts in it too.
      const tracks = this.hls.audioTracks;
      if (tracks.length > 1) {
        // VF / VO only says something when the film has a French track to choose against.
        const french = pickAudioTrack(tracks, 'fr');
        if (french !== null) {
          this.audioPref = french === id ? 'fr' : 'vo';
          localStorageSet(AUDIO_KEY, this.audioPref);
        }
        const lang = langCode(tracks[id]?.lang);
        localStorageSet(AUDIO_LANG_KEY, lang || '');
      }
    }
    this.onChange();
  }

  setSubtitleTrack(id: number) {
    this.subtitleTrack = id;
    if (this.hls) {
      this.hls.subtitleTrack = id;
      // Cues still load into a hidden text track: the stage draws them in the viewer's style.
      this.hls.subtitleDisplay = false;
    }
    this.onChange();
  }

  /** Called from a click when the browser blocked autoplay. */
  unlock() {
    this.needsGesture = false;
    this.video.play().catch(() => {});
    this.onChange();
  }

  /** Seconds this stream has been loading without anything to show, or null. */
  loadingFor(now = Date.now()) {
    if (!this.media || this.detached || this.error || this.video.readyState >= 2) return null;
    return (now - (this.notReadySince || this.loadStartedAt)) / 1000;
  }

  /** Reloads the stream now (the "Réessayer" button). */
  reload() {
    if (!this.media || !this.quality) return;
    this.error = null;
    this.fatalCount = 0;
    this.startHls(this.quality, this.localPosition());
  }

  /**
   * Nothing arrives at all (the room runs, the screen stays black): reload once after
   * 30 s, then go one quality down (lighter for the server to prepare) after 30 s more.
   */
  private watchLoading(v: HTMLVideoElement, now: number) {
    if (!this.state?.running || v.readyState >= 1 || !this.quality || now - this.loadStartedAt < LOAD_RETRY_MS) return;
    this.loadRetries++;
    const lower = this.ladder[this.ladder.indexOf(this.quality) + 1];
    if (this.loadRetries >= 2 && lower) {
      this.fallback = `Rien n'arrivait en ${this.quality === '2160' ? '4K' : `${this.quality}p`} : passage en ${lower === '2160' ? '4K' : `${lower}p`}`;
      // Auto quality starts again from there (it would climb straight back otherwise).
      if (this.abr) this.abr = new AutoQuality(this.ladder, lower, now);
      this.switchQuality(lower);
    } else {
      this.startHls(this.quality, this.localPosition());
    }
  }

  /** Black screen: the time runs but no picture is decoded. */
  private watchPicture(v: HTMLVideoElement) {
    if (v.error?.code === MediaError.MEDIA_ERR_DECODE) {
      if (this.pictureFailed('erreur de décodage')) return;
    }
    const frames = this.decodedFrames();
    // A tab in the background decodes no pictures on purpose: not a black screen.
    if (frames === null || v.paused || v.seeking || document.hidden) {
      this.frames = -1;
      return;
    }
    if (frames !== this.frames || this.frames < 0) {
      if (this.frames >= 0 && frames > this.frames && this.error === NO_PICTURE) {
        this.error = null;
        this.onChange();
      }
      this.frames = frames;
      this.framesTime = v.currentTime;
      return;
    }
    const ran = v.currentTime - this.framesTime;
    if (ran > NO_PICTURE_S && (frames === 0 || v.videoWidth === 0 || ran > NO_PICTURE_S * 2)) {
      this.frames = -1;
      if (!this.pictureFailed("pas d'image")) {
        this.error = NO_PICTURE;
        this.onChange();
      }
    }
  }

  private send(value: boolean) {
    this.conn.send({ t: 'buffering', value });
  }

  private tick() {
    const s = this.state;
    const v = this.video;
    if (!s?.media || !this.media) return;
    const now = Date.now();
    if (v.readyState >= 2) this.notReadySince = 0;
    else if (!this.notReadySince) this.notReadySince = now;

    // Load barrier (start of a film): tell the room this viewer can play.
    if (this.pendingReady && v.readyState >= 3 && !v.seeking) {
      this.pendingReady = false;
      this.send(false);
    }

    // A room jump that came during a reload: now that something is loaded.
    if (this.pendingSeek && v.readyState >= 1 && !v.seeking) {
      this.pendingSeek = false;
      if (Math.abs(v.currentTime - this.expected()) > 0.5) {
        v.currentTime = this.expected();
        this.afterJump();
      }
    }

    if (s.running && !v.ended) {
      // Arrived while the film runs (or the load took a while, or the clock was not known
      // yet): start at the live, once, before anything was seen (nothing to lose).
      if (!this.hasPlayed && !this.joinedLive && v.readyState >= 1 && !v.seeking && this.conn.clock.ready) {
        this.joinedLive = true;
        if (Math.abs(this.expected() - v.currentTime) > 1.5) {
          v.currentTime = this.expected();
          this.afterJump();
        }
      }
      if (v.paused && !this.needsGesture && v.readyState >= 2) {
        v.play().catch((err: DOMException) => {
          if (err.name === 'NotAllowedError') {
            this.needsGesture = true;
            this.onChange();
          }
        });
      }
      if (v.playbackRate !== 1) v.playbackRate = 1;

      // A stall only matters to the automatic quality now (it holds nobody).
      const stalled = !v.paused && !v.seeking && v.readyState < 3 && this.hasPlayed && now > this.graceUntil;
      if (stalled) {
        if (!this.stallSince) this.stallSince = now;
        else if (now - this.stallSince > STALL_REPORT_MS && !this.stalled) {
          this.stalled = true;
          const next = this.abr?.onStall(now);
          if (next) this.switchQuality(next);
        }
      } else {
        this.stallSince = 0;
        this.stalled = false;
      }
      if (!v.paused && v.readyState >= 3 && v.currentTime > 1) this.hasPlayed = true;
    } else if (!s.running) {
      // Paused (or the start of the film waits for someone): everyone stops where they are.
      if (!v.paused) v.pause();
      if (v.playbackRate !== 1) v.playbackRate = 1;
      // Sit at the room's position: before playing anything, and after a pause when only the
      // pause message's delay separates us (it would add up pause after pause). Those really
      // behind (more than 2 s) stay where they are.
      const gap = Math.abs(v.currentTime - this.expected());
      if (!v.seeking && v.readyState >= 1 && gap > (this.hasPlayed ? 0.1 : 0.25) && (!this.hasPlayed || gap < 2)) v.currentTime = this.expected();
      this.stallSince = 0;
      this.stalled = false;
    }

    // Tell the room where this viewer is (who is behind the live, when the film is over).
    // Not while nothing really plays here (error, autoplay blocked, not started yet): such
    // a viewer must not hold the end of the film for everyone.
    const reporting = !this.error && !this.needsGesture && (this.hasPlayed || !s.running) && !this.pendingSeek;
    if (reporting && v.readyState >= 1 && !v.seeking && now - this.lastPositionSent > POSITION_EVERY_MS) {
      this.lastPositionSent = now;
      this.conn.send({ t: 'position', value: v.ended ? this.media.duration || v.currentTime : v.currentTime });
    }

    this.watchPicture(v);
    this.watchLoading(v, now);
  }
}
