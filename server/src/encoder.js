// Host GPU encoders: the "Encodeur Watch Party" desktop app (encoder/ in this repo) runs on
// a room member's PC, connects to this server and turns the film into the qualities
// viewers ask for with that PC's GPU (NVENC, Quick Sync, AMF, VideoToolbox, VA-API), so
// the server never transcodes. The server keeps doing what is cheap: downloading the
// torrent, copying a stream that browsers can play as is, relaying segments.
//
// Protocol (JSON over a WebSocket, segments over HTTP PUT):
//   agent → server  hello {version, os, encoder, device, maxHeight}
//   server → agent  job {id, source, duration, segment, video, audio}
//   server → agent  want {job, start, until, video:[{id, width, height, bitrate}], audio:[n]}
//                   (encode segments start..until of these renditions, in one process)
//   server → agent  extend {job, until}            stop {job, reason}
//   agent → server  progress {job, fps}            error {job, message}
//   agent → server  PUT /api/encoder/segment/:job/:rendition/:index (MPEG-TS bytes)
// Segments are SEGMENT_S seconds on a fixed grid (segment i starts at i × SEGMENT_S), so
// playlists are known in advance and a seek is just "encode from segment i".

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SEGMENT_S = 4;
/** Segments encoded ahead of the furthest one asked for. */
const AHEAD = 20;
/** How long a segment request waits for the encoder. */
const WAIT_MS = 40_000;
/** A rendition counts as watched this long after its last request. */
const ACTIVE_MS = 90_000;
/** Failures within FAILURE_WINDOW_MS before the server takes the job back. */
const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 120_000;
/** After a failure the film goes back to the app after this long (doubling, at most RETRY_MAX_MS). */
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 10 * 60_000;
/**
 * A job that works this long without failing has recovered: the next failure waits the
 * shortest delay again. Before that, a segment served doesn't reset the delay, or an app
 * that works a minute then fails would take the film and give it back every minute (each
 * change reloads the stream of every viewer who gets a conversion: a cut).
 */
const STABLE_MS = 5 * 60_000;
/** The app counts as working while it served a segment this recently. */
const WORKING_MS = 30_000;

/** Video renditions the encoder makes (H.264, every browser plays it). */
export const GPU_VIDEO = {
  2160: { height: 2160, bitrate: 16_000_000 },
  1080: { height: 1080, bitrate: 6_000_000 },
  720: { height: 720, bitrate: 3_000_000 },
  480: { height: 480, bitrate: 1_400_000 },
};
const AUDIO_BITRATE = 160_000;

// ---------------------------------------------------------------- keys

const sha256 = (s) => createHash('sha256').update(s).digest();

/** A new pairing key: the app gets `token`, the database keeps `hash`. */
export function newKey() {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return { id, token: `wpe_${id}.${secret}`, hash: sha256(secret).toString('hex') };
}

export function parseKey(token) {
  const m = /^wpe_([0-9a-f]{12})\.([\w-]{32})$/.exec(String(token || ''));
  return m ? { id: m[1], secret: m[2] } : null;
}

export function keyMatches(secret, hashHex) {
  const a = sha256(secret);
  const b = Buffer.from(String(hashHex || ''), 'hex');
  return b.length === a.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- playlists

export const segmentCount = (duration) => Math.max(1, Math.ceil((Number(duration) || 0) / SEGMENT_S));

/** VOD playlist of one rendition: every segment on the fixed grid, encoded on demand. */
export function mediaPlaylist(duration, dir) {
  const n = segmentCount(duration);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT_S}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 && duration ? duration - i * SEGMENT_S : SEGMENT_S;
    lines.push(`#EXTINF:${Math.max(0.1, len).toFixed(3)},`, `${dir}/${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Output size of a rendition: its height, the source's shape, even numbers, never above the source. */
export function renditionSize(quality, source) {
  const r = GPU_VIDEO[quality];
  if (!r || !source?.width || !source?.height) return null;
  const height = Math.min(r.height, source.height);
  const width = Math.round((height * source.width) / source.height / 2) * 2;
  return { width, height: height - (height % 2), bitrate: r.bitrate };
}

const quote = (s) => String(s).replace(/["\n\r]/g, '');

/** Master playlist: the viewer's video rendition + every audio track as alternatives. */
export function masterPlaylist(quality, info) {
  const size = renditionSize(quality, info.video);
  if (!size) return null;
  const audio = info.audio || [];
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  audio.forEach((a, n) => {
    const name = quote(a.title || a.language || `Piste ${n + 1}`);
    const lang = /^[a-z]{2,3}$/i.test(a.language || '') ? `,LANGUAGE="${a.language}"` : '';
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}"${lang},DEFAULT=${n === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="gaudio${n}.m3u8"`);
  });
  const bandwidth = size.bitrate + (audio.length ? AUDIO_BITRATE : 0);
  const codecs = audio.length ? 'avc1.640028,mp4a.40.2' : 'avc1.640028';
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${size.width}x${size.height},CODECS="${codecs}"${audio.length ? ',AUDIO="aud"' : ''}`,
    'gvideo.m3u8',
    ''
  );
  return lines.join('\n');
}

/** Relay paths served from the encoder (the Stremio converter's never start with "g"). */
const GPU_PATH_RE = /^(?:gvideo\.m3u8|gaudio(\d{1,2})\.m3u8|gv\/(\d{1,6})\.ts|ga(\d{1,2})\/(\d{1,6})\.ts)$/;

export function parseGpuPath(rest) {
  const m = GPU_PATH_RE.exec(rest);
  if (!m) return null;
  if (rest === 'gvideo.m3u8') return { kind: 'playlist', rendition: 'v' };
  if (m[1] !== undefined) return { kind: 'playlist', rendition: `a${Number(m[1])}` };
  if (m[2] !== undefined) return { kind: 'segment', rendition: 'v', index: Number(m[2]) };
  return { kind: 'segment', rendition: `a${Number(m[3])}`, index: Number(m[4]) };
}

// ---------------------------------------------------------------- segment cache

/** Encoded segments in memory, least recently used dropped first (the disk is small). */
export class SegmentCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const buf = this.map.get(key);
    if (!buf) return null;
    this.map.delete(key);
    this.map.set(key, buf);
    return buf;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, buf) {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, buf);
    this.bytes += buf.length;
    for (const [k, b] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= b.length;
    }
  }

  dropPrefix(prefix) {
    for (const [k, b] of this.map) {
      if (!k.startsWith(prefix)) continue;
      this.map.delete(k);
      this.bytes -= b.length;
    }
  }
}

// ---------------------------------------------------------------- hub

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : null);

/** What the app says about itself, checked (it runs on someone's PC, not trusted). */
export function cleanHello(msg) {
  return {
    version: text(msg.version, 20) || '?',
    os: text(msg.os, 20) || '?',
    encoder: text(msg.encoder, 30) || '?',
    device: text(msg.device, 80) || null,
    maxHeight: [480, 720, 1080, 1440, 2160].includes(msg.maxHeight) ? msg.maxHeight : 1080,
  };
}

export class EncoderHub {
  /**
   * `keys(id)` → { uid, hash, label } of a pairing key (database), `onChange(sid)` is
   * called when a media session gains or loses its encoder.
   */
  constructor({ keys, log, cacheBytes = 768 * 1024 ** 2, now = Date.now, onChange = () => {}, onAgents = () => {} }) {
    this.keys = keys;
    this.log = log;
    this.now = now;
    this.onChange = onChange;
    this.onAgents = onAgents;
    this.cache = new SegmentCache(cacheBytes);
    /** key id → agent */
    this.agents = new Map();
    /** job id → job */
    this.jobs = new Map();
  }

  /** The pairing key of an app (Authorization: Bearer wpe_…), or null. */
  authenticate(token) {
    const parsed = parseKey(token);
    if (!parsed) return null;
    const key = this.keys(parsed.id);
    if (!key || !keyMatches(parsed.secret, key.hash)) return null;
    return { id: parsed.id, uid: key.uid, label: key.label };
  }

  /** A paired app connected: `send(obj)` writes to its socket, `close()` ends it. */
  connect(key, send, close) {
    const old = this.agents.get(key.id);
    if (old) {
      // Its socket may close later (or never, half-dead): its films go now, else they would
      // stay with an app that no longer reads them and the new one would get nothing.
      for (const job of [...old.jobs]) this.detach(job, 'Encodeur reconnecté');
      old.close();
    }
    const agent = { id: key.id, uid: key.uid, label: key.label, send, close, info: null, jobs: new Set(), since: this.now() };
    this.agents.set(key.id, agent);
    return agent;
  }

  disconnect(agent) {
    if (this.agents.get(agent.id) !== agent) return;
    this.agents.delete(agent.id);
    for (const job of [...agent.jobs]) this.detach(job, 'Encodeur déconnecté');
    this.onAgents(agent.uid);
  }

  message(agent, msg) {
    switch (msg?.type) {
      case 'hello':
        agent.info = cleanHello(msg);
        this.log?.info({ uid: agent.uid, ...agent.info }, 'GPU encoder connected');
        this.onAgents(agent.uid);
        return;
      case 'progress': {
        const job = this.jobs.get(msg.job);
        if (job?.agent === agent && Number.isFinite(msg.fps)) job.fps = Math.round(msg.fps);
        return;
      }
      case 'error': {
        const job = this.jobs.get(msg.job);
        if (job?.agent !== agent) return;
        job.lastError = text(msg.message, 200);
        this.log?.warn({ job: job.id, err: job.lastError }, 'GPU encoder error');
        this.fail(job);
        return;
      }
      default:
    }
  }

  /** The app of this user that is connected and ready, if any. */
  online(uid) {
    let best = null;
    for (const a of this.agents.values()) if (a.uid === uid && a.info && (!best || a.since > best.since)) best = a;
    return best;
  }

  /** For the settings page / room UI. */
  status(uid) {
    const a = this.online(uid);
    return a ? { online: true, ...a.info, label: a.label } : { online: false };
  }

  /**
   * Gives a media session to the first of these users whose encoder is online.
   * Returns the job, or null (the Stremio converter does the work then).
   */
  attach(session, uids) {
    if (session.gpu || !session.info?.video) return session.gpu || null;
    // Taken back after a failure: wait before trying the app again.
    if (session.gpuRetryAt && this.now() < session.gpuRetryAt) return null;
    for (const uid of uids) {
      const agent = uid && this.online(uid);
      if (!agent) continue;
      const job = {
        id: randomBytes(9).toString('base64url'),
        sid: session.sid,
        session,
        agent,
        uid,
        run: null,
        active: new Map(),
        waiters: new Map(),
        failures: [],
        fps: null,
        // Lets ffmpeg on the app read the source without the pairing key (see encoderRoutes).
        sourceToken: randomBytes(18).toString('base64url'),
        servedAt: 0,
        served: 0,
        startedAt: this.now(),
      };
      this.jobs.set(job.id, job);
      agent.jobs.add(job);
      session.gpu = job;
      agent.send({
        type: 'job',
        job: {
          id: job.id,
          source: `/api/encoder/source/${job.id}?t=${job.sourceToken}`,
          duration: session.info.duration,
          segment: SEGMENT_S,
          video: session.info.video,
          audio: (session.info.audio || []).length,
        },
      });
      this.log?.info({ sid: session.sid, uid }, 'media handed to a GPU encoder');
      this.onChange(session.sid);
      return job;
    }
    return null;
  }

  sourceTokenMatches(job, token) {
    if (typeof token !== 'string' || token.length !== job.sourceToken.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(job.sourceToken));
  }

  /**
   * Takes the job back (encoder gone or failing): viewers fall back to the server. After a
   * failure (`retry`), the film goes back to the app a little later, sooner if it recovers.
   */
  detach(job, reason, { retry = false } = {}) {
    if (!this.jobs.has(job.id)) return;
    this.jobs.delete(job.id);
    job.agent.jobs.delete(job);
    const session = job.session;
    if (session.gpu === job) session.gpu = null;
    if (retry) {
      session.gpuDelay = Math.min((session.gpuDelay || RETRY_MS / 2) * 2, RETRY_MAX_MS);
      session.gpuRetryAt = this.now() + session.gpuDelay;
      session.gpuError = reason;
    }
    try {
      job.agent.send({ type: 'stop', job: job.id, reason, retryIn: retry ? Math.round(session.gpuDelay / 1000) : null });
    } catch {}
    for (const list of job.waiters.values()) for (const w of list) w.reject(new Error(reason));
    job.waiters.clear();
    this.cache.dropPrefix(`${job.id}/`);
    this.log?.info({ sid: job.sid, reason }, 'GPU encoder detached');
    this.onChange(job.sid);
  }

  /** Session ended (room stopped, replaced): the app stops encoding it. */
  release(session) {
    if (session.gpu) this.detach(session.gpu, 'Lecture terminée');
  }

  fail(job) {
    const t = this.now();
    job.failures = job.failures.filter((x) => t - x < FAILURE_WINDOW_MS);
    job.failures.push(t);
    if (job.failures.length >= MAX_FAILURES) this.detach(job, job.lastError || 'Encodeur trop lent', { retry: true });
  }

  /** Public description for the room (who accelerates, with what). */
  describe(job) {
    if (!job) return null;
    const i = job.agent.info || {};
    return { by: job.uid, encoder: i.encoder || null, device: i.device || null };
  }

  /** A segment went to a viewer (for the statistics: is the GPU really working?). */
  served(job) {
    job.servedAt = this.now();
    job.served++;
    job.session.gpuError = null;
    // Working for a while: the next failure waits the shortest delay.
    const t = this.now();
    if (t - job.startedAt >= STABLE_MS && !job.failures.some((x) => t - x < FAILURE_WINDOW_MS)) job.session.gpuDelay = 0;
  }

  /**
   * What the player's statistics show about the GPU of a media session: who encodes,
   * with what, and whether it is busy right now; or why it isn't used.
   */
  state(session, uids = []) {
    const job = session.gpu;
    if (job) {
      const i = job.agent.info || {};
      return {
        status: this.now() - job.servedAt < WORKING_MS ? 'working' : 'ready',
        by: job.uid,
        encoder: i.encoder || null,
        device: i.device || null,
        maxHeight: i.maxHeight || null,
        fps: job.fps,
        segments: job.served,
      };
    }
    const online = uids.map((uid) => uid && this.online(uid)).find(Boolean);
    if (!online) return null;
    const i = online.info || {};
    const retryIn = session.gpuRetryAt ? Math.max(0, Math.round((session.gpuRetryAt - this.now()) / 1000)) : 0;
    return {
      status: retryIn > 0 ? 'retry' : 'idle',
      by: online.uid,
      encoder: i.encoder || null,
      device: i.device || null,
      error: session.gpuError || null,
      retryIn,
    };
  }

  /** Does the encoder make this quality? (else the server converts it as before) */
  serves(job, quality) {
    const max = job.agent.info?.maxHeight || 1080;
    return !!GPU_VIDEO[quality] && GPU_VIDEO[quality].height <= Math.max(max, 480);
  }

  // ------------------------------------------------------------ segments

  /** Waits for a segment (asks the app to encode it if needed). */
  async segment(job, quality, rendition, index, signal) {
    if (index < 0 || index >= segmentCount(job.session.info.duration)) throw Object.assign(new Error('Segment hors du film'), { status: 404 });
    const name = rendition === 'v' ? `v${quality}` : rendition;
    const key = `${job.id}/${name}/${index}`;
    const hit = this.cache.get(key);
    job.active.set(name, this.now());
    this.#demand(job, name, index, !!hit);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const list = job.waiters.get(key) || [];
      list.push(entry);
      job.waiters.set(key, list);
      const done = () => {
        clearTimeout(timer);
        const l = job.waiters.get(key);
        if (l) {
          l.splice(l.indexOf(entry), 1);
          if (!l.length) job.waiters.delete(key);
        }
      };
      const timer = setTimeout(() => {
        done();
        job.lastError = `Segment pas prêt en ${WAIT_MS / 1000} s`;
        this.fail(job);
        reject(Object.assign(new Error('Encodeur trop lent'), { status: 504 }));
      }, WAIT_MS);
      entry.resolve = (buf) => (done(), resolve(buf));
      entry.reject = (err) => (done(), reject(err));
      signal?.addEventListener('abort', () => entry.reject(Object.assign(new Error('aborted'), { status: 499 })), { once: true });
    });
  }

  /** Renditions someone watched recently (the app encodes them together, one decode). */
  #activeSet(job) {
    const t = this.now();
    for (const [name, at] of job.active) if (t - at > ACTIVE_MS) job.active.delete(name);
    return [...job.active.keys()].sort();
  }

  #demand(job, name, index, cached) {
    const set = this.#activeSet(job);
    const run = job.run;
    const covered = run && run.set.includes(name) && set.every((r) => run.set.includes(r));
    const reached = run ? (run.done.get(name) ?? run.start - 1) : -1;
    if (covered && index >= run.start && index <= reached + 3) {
      // The app is on it (or about to be): keep it ahead of the viewers.
      if (run.until - index < AHEAD / 2) {
        run.until = Math.min(index + AHEAD, segmentCount(job.session.info.duration) - 1);
        job.agent.send({ type: 'extend', job: job.id, until: run.until });
      }
      return;
    }
    if (cached) return;
    this.#start(job, set.includes(name) ? set : [...set, name].sort(), index);
  }

  #start(job, set, start) {
    const last = segmentCount(job.session.info.duration) - 1;
    const info = job.session.info;
    job.run = { start, until: Math.min(start + AHEAD, last), set, done: new Map() };
    job.agent.send({
      type: 'want',
      job: job.id,
      start,
      until: job.run.until,
      video: set
        .filter((r) => r.startsWith('v'))
        .map((r) => ({ id: r.slice(1), ...renditionSize(r.slice(1), info.video) })),
      audio: set.filter((r) => r.startsWith('a')).map((r) => Number(r.slice(1))),
    });
  }

  /** A segment arrives from the app. Returns false when it isn't expected from this app. */
  upload(agentId, jobId, name, index, buf) {
    const job = this.jobs.get(jobId);
    if (!job || job.agent.id !== agentId) return false;
    if (!/^(?:v(?:2160|1080|720|480)|a\d{1,2})$/.test(name) || !Number.isInteger(index) || index < 0) return false;
    if (index >= segmentCount(job.session.info.duration)) return false;
    const key = `${job.id}/${name}/${index}`;
    this.cache.set(key, buf);
    if (job.run) job.run.done.set(name, Math.max(job.run.done.get(name) ?? -1, index));
    for (const w of [...(job.waiters.get(key) || [])]) w.resolve(buf);
    return true;
  }
}
