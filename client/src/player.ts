import Hls from 'hls.js';
import type { RoomMedia, RoomState } from './api.ts';
import { AutoQuality } from './abr.ts';
import type { Connection } from './connection.ts';
import { localStorageGet, localStorageSet } from './auth.ts';
import { correction, expectedPosition, SEEK_THRESHOLD } from './sync.ts';
import { pickAudioTrack, audioChipLabel, langCode } from './format.ts';
import { bufferedAhead, bufferHealth, catchUpTarget, ewma, fragmentRatio, MAX_LEAD_S, type Health } from './health.ts';
import { cachedCaps, markBroken, outputOf, probeCaps, type Caps, type Codec } from './codecprobe.ts';

export type { Caps } from './codecprobe.ts';

const TICK_MS = 250;
const STALL_REPORT_MS = 800;
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
 * viewer's quality, keeps it within ~0.1 s of the room, reports stalls/readiness and
 * picks the quality automatically.
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
  private reportedStall = false;
  private lastStallReport = 0;
  /** This viewer's uid, to notice when the room stopped waiting for it. */
  uid: string | null = null;
  private stallSince = 0;
  private graceUntil = 0;
  private hasPlayed = false;
  private fatalCount = 0;
  private lastFatalAt = 0;
  /** Since when nothing can be shown (readyState < 2), for the loading overlay. */
  private notReadySince = 0;
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
      this.startHls(this.quality, this.expected());
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
    this.startHls(this.quality, this.expected());
    return true;
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
    if (this.detached) return;
    if (!state.media) {
      if (this.media) this.unload();
      return;
    }
    if (state.media.sid !== this.media?.sid) {
      this.load(state.media);
      return;
    }
    // A GPU encoder took over (or left): same film, reload the stream from where the room is.
    // Only viewers who get a conversion: a copy of the source does not go through the GPU.
    if ((state.media.encoder?.by || null) !== (this.media.encoder?.by || null)) {
      this.media = state.media;
      if (this.quality && this.output()?.mode === 'transcode') this.startHls(this.quality, this.expected());
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
      this.reportedStall = false;
      if (this.media) this.unload();
    } else if (this.state?.media) {
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
      this.audioTracks = hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Piste ${i + 1}`, short: audioChipLabel(t, i) }));
      // First time this media's tracks are known: apply the viewer's VF / VO choice.
      if (!this.audioPicked && hls.audioTracks.length) {
        this.audioPicked = true;
        const wanted = pickAudioTrack(hls.audioTracks, this.audioPref, localStorageGet(AUDIO_LANG_KEY));
        if (wanted !== null && wanted !== this.audioTrack) {
          this.audioTrack = wanted;
          hls.audioTrack = wanted;
        }
      }
      this.subtitleTracks = hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Sous-titres ${i + 1}`, lang: t.lang || undefined }));
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
    this.startHls(this.quality, this.expected());
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
      this.startHls(this.quality, this.expected());
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
    const expected = this.expected();
    if (v.readyState >= 2) this.notReadySince = 0;
    else if (!this.notReadySince) this.notReadySince = now;
    // The end of the film: stay on the last picture (playing again would loop on it).
    const atEnd = v.ended || (!!s.media.duration && expected >= s.media.duration - 0.5);

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

    if (s.running && atEnd) {
      if (v.playbackRate !== 1) v.playbackRate = 1;
    } else if (s.running && !(this.holding && v.paused)) {
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
          this.lastStallReport = now;
          this.send(true);
          const next = this.abr?.onStall(now);
          if (next) this.switchQuality(next);
        }
        // The room gave up waiting for us (10 s) but we're still stuck: ask for a second
        // chance. The server grants a short wait, at most twice a minute per viewer.
        else if (this.reportedStall && this.uid && !s.waiting.includes(this.uid) && now - this.lastStallReport > 5000) {
          this.lastStallReport = now;
          this.send(true);
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

    this.watchPicture(v);
    this.watchLoading(v, now);

    if (this.reportedStall && v.readyState >= 3 && !v.seeking) {
      this.reportedStall = false;
      this.send(false);
    }
  }
}
