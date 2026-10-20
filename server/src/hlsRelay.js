// Between the browsers and the Stremio converters (/hlsv2): keeps what they made, and asks
// them for one segment at a time, in order.
//
// A Stremio converter (one per quality, one per audio track) is a single ffmpeg that makes
// segments one after another and keeps only the last one. Asked for any other segment, it
// cancels the one in progress (the asker gets an error) and restarts ffmpeg from there. Two
// viewers on the same converter a few segments apart (their buffers are never equally full)
// therefore cancel each other on every request: errors, retries, seconds without sound or
// picture. And a restart in a transcoded Matroska file shows a frozen picture until the next
// keyframe (ffmpeg is told to seek to any frame there, -seek2any).
//
// So here:
//  - every segment, init segment and playlist is kept in memory (least recently used dropped
//    first): a viewer behind the others gets what they already fetched;
//  - per converter track, one request at a time goes to Stremio, the next segment of the run
//    in progress first: the converter restarts only when somebody really jumps elsewhere;
//  - the segments right after the ones being watched are made in advance, so a transcode
//    slower than the network still has its next segment ready;
//  - when a transcoded Matroska video must restart, it restarts one segment earlier, so the
//    frozen picture falls in a segment nobody watches;
//  - converters of rooms on pause are kept alive (Stremio drops them after 2 min without a
//    request, and starting again costs an analysis and a restart).

import { SegmentCache } from './encoder.js';
import { rewritePlaylist } from './media.js';

const SEGMENT_RE = /^((?:video|audio|subtitle)\d+)\/segment(\d+)\.(m4s|vtt)$/;
/** Segments made ahead of the furthest one a viewer read, per kind of track. */
const AHEAD = { video: 2, audio: 3, subtitle: 0 };
/** Extra segments made before a restart point of a transcoded Matroska video (see above). */
const PREROLL = 1;
/** A viewer that read this recently keeps the run going (made ahead for them). */
const FOLLOW_MS = 30_000;
/** A request waits at most this long behind the run in progress before the converter jumps to it. */
const JUMP_AFTER_MS = 4_000;
/** A request this few segments past the run's next one is reached by going on, not by a restart. */
const NEAR = 2;
/** One segment from Stremio: as long as the browsers wait (hls.js gives up at 120 s). */
const UPSTREAM_MS = 120_000;
/**
 * An AAC segment this small is digital silence. A converter whose ffmpeg lost its input (the
 * torrent engine ended its HTTP response: Huwa does so to every reader of a torrent more than
 * 32 MiB away when another reader opens it, e.g. a new ffmpeg for another quality reading the
 * file header) does not stop: its audio is padded with silence for good (`-af apad`), ~2 KB
 * per segment instead of ~130 KB, until something restarts it.
 */
export const SILENT_AUDIO_BYTES = 6 * 1024;
/** Converters read this recently are kept alive while their room plays the film. */
const KEEP_ALIVE_MS = 20 * 60_000;

const contentType = (rest) =>
  rest.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : rest.endsWith('.vtt') ? 'text/vtt' : 'video/mp4';

const httpError = (status, message, detail) => Object.assign(new Error(message), { status, detail });

export class HlsRelay {
  /**
   * fetch(session, params, rest, signal) → Response from the Stremio server (media.fetchHls).
   */
  constructor({ fetch, cacheBytes = 512 * 1024 ** 2, log = null, now = Date.now, ahead = AHEAD, preroll = PREROLL }) {
    this.upstream = fetch;
    this.cache = new SegmentCache(cacheBytes);
    this.log = log;
    this.now = now;
    this.ahead = ahead;
    this.preroll = preroll;
    /** `${convertId}/${track}` → lane (one converter track) */
    this.lanes = new Map();
    /** playlist / init requests in progress, shared by everyone asking the same */
    this.inflight = new Map();
    /** convertId → restarts after Stremio said it was destroyed (see #id) */
    this.generations = new Map();
    /** convertId → media session id (what prune forgets) */
    this.owners = new Map();
  }

  /** Converter id actually used: a destroyed one stays registered in Stremio, so a new name. */
  #id(convertId) {
    const n = this.generations.get(convertId);
    return n ? `${convertId}r${n}` : convertId;
  }

  /**
   * Fetches from Stremio, retrying once a converter it destroyed (sweep, or a dropped
   * one still named) or a segment it canceled.
   */
  async #fetch(session, params, rest, signal) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.upstream(session, { ...params, convertId: this.#id(params.convertId) }, rest, signal);
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      if (attempt === 0 && /is destroyed/.test(body)) {
        this.generations.set(params.convertId, (this.generations.get(params.convertId) || 0) + 1);
        continue;
      }
      if (attempt === 0 && /canceled/.test(body)) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw httpError(502, 'Erreur du convertisseur', { status: res.status, body: body.slice(0, 300) });
    }
  }

  /** Playlist or init segment: the same for everyone, made once. */
  async #shared(session, params, rest) {
    const key = `${params.convertId}/${rest}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.inflight.has(key)) {
      const job = (async () => {
        const res = await this.#fetch(session, params, rest, AbortSignal.timeout(UPSTREAM_MS));
        const body = rest.endsWith('.m3u8') ? Buffer.from(rewritePlaylist(await res.text())) : Buffer.from(await res.arrayBuffer());
        this.cache.set(key, body);
        return body;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return this.inflight.get(key);
  }

  /**
   * What the browser gets for this relay path: { type, body }. Throws an error with
   * .status (and .detail from Stremio) otherwise.
   */
  async serve(session, params, rest, signal) {
    this.owners.set(params.convertId, session.sid);
    const type = contentType(rest);
    const m = SEGMENT_RE.exec(rest);
    if (!m) return { type, body: await this.#shared(session, params, rest) };
    const lane = this.#lane(session, params, m[1]);
    const seq = Number(m[2]);
    lane.lastUsed = this.now();
    lane.recent.push({ seq, at: lane.lastUsed });
    if (lane.recent.length > 32) lane.recent.shift();
    const hit = this.cache.get(this.#key(lane, seq));
    if (hit) {
      this.#pump(lane);
      return { type, body: hit };
    }
    if (signal?.aborted) throw httpError(499, 'aborted');
    const body = await new Promise((resolve, reject) => {
      const waiter = { seq, at: this.now(), resolve, reject };
      lane.waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = lane.waiters.indexOf(waiter);
          if (i >= 0) lane.waiters.splice(i, 1);
          reject(httpError(499, 'aborted'));
        },
        { once: true }
      );
      this.#pump(lane);
    });
    return { type, body };
  }

  #key(lane, seq) {
    return `${lane.id}/segment${seq}`;
  }

  #lane(session, params, track) {
    const id = `${params.convertId}/${track}`;
    let lane = this.lanes.get(id);
    if (!lane) {
      const kind = track.replace(/\d+$/, '');
      lane = {
        id,
        sid: session.sid,
        track,
        // The converter's next segment if nothing else is asked (null: unknown, a restart).
        next: null,
        end: Infinity,
        busy: false,
        waiters: [],
        recent: [],
        lastUsed: this.now(),
        ahead: this.ahead[kind] ?? 0,
        preroll: kind === 'video' && params.mode === 'transcode' && /matroska/.test(session.info?.container || '') ? this.preroll : 0,
      };
      this.lanes.set(id, lane);
    }
    lane.session = session;
    lane.params = params;
    return lane;
  }

  /** Next segments to ask Stremio for, or [] (nothing to do). */
  #plan(lane) {
    const now = this.now();
    const cached = (s) => this.cache.has(this.#key(lane, s));
    const waiting = lane.waiters.filter((w) => !cached(w.seq));
    // Already made meanwhile (another viewer's request): hand them over.
    for (const w of lane.waiters.filter((x) => cached(x.seq))) this.#settle(lane, w.seq);
    if (waiting.length) {
      const oldest = waiting.reduce((a, b) => (b.at < a.at ? b : a));
      const inRun = lane.next !== null && waiting.some((w) => w.seq === lane.next);
      if (inRun && now - oldest.at < JUMP_AFTER_MS) return [lane.next];
      const target = oldest.seq;
      let start = target;
      if (lane.next !== null && target >= lane.next && target - lane.next <= NEAR) {
        // Just ahead of the run: going on costs less than a restart (which makes one too).
        start = lane.next;
      } else {
        // A restart: from a bit earlier when its first segment would show a frozen picture.
        while (start > 1 && target - start < lane.preroll && !cached(start - 1)) start--;
      }
      return Array.from({ length: target - start + 1 }, (_, i) => start + i);
    }
    // Nobody waits: keep the run ahead of the viewers that follow it.
    const s = lane.next;
    if (s === null || s >= lane.end || !lane.ahead || cached(s)) return [];
    const followed = lane.recent.some((r) => now - r.at < FOLLOW_MS && r.seq < s && r.seq >= s - lane.ahead);
    return followed ? [s] : [];
  }

  /** An audio segment of silence right after one with sound (see SILENT_AUDIO_BYTES). */
  #lostSound(lane, seq, body) {
    if (!lane.track.startsWith('audio') || body.length >= SILENT_AUDIO_BYTES) return false;
    const before = this.cache.get(this.#key(lane, seq - 1));
    return !!before && before.length >= SILENT_AUDIO_BYTES;
  }

  #settle(lane, seq, err = null, body = null) {
    const value = err ? null : body || this.cache.get(this.#key(lane, seq));
    lane.waiters = lane.waiters.filter((w) => {
      if (w.seq !== seq) return true;
      if (value) w.resolve(value);
      else w.reject(err || httpError(502, 'Segment perdu'));
      return false;
    });
  }

  #pump(lane) {
    if (lane.busy) return;
    const plan = this.#plan(lane);
    if (!plan.length) return;
    lane.busy = true;
    (async () => {
      for (const seq of plan) {
        try {
          const rest = `${lane.track}/segment${seq}.${lane.track.startsWith('subtitle') ? 'vtt' : 'm4s'}`;
          const res = await this.#fetch(lane.session, lane.params, rest, AbortSignal.timeout(UPSTREAM_MS));
          let body = Buffer.from(await res.arrayBuffer());
          if (this.#lostSound(lane, seq, body)) {
            // Sound, then silence: made again once by a fresh converter (a new id, see #id). A
            // silence that is in the film (silent before, or silent again) is served as is.
            this.generations.set(lane.params.convertId, (this.generations.get(lane.params.convertId) || 0) + 1);
            this.log?.info({ lane: lane.id, seq, bytes: body.length }, 'hls relay: silent audio, converter replaced');
            body = await this.#fetch(lane.session, lane.params, rest, AbortSignal.timeout(UPSTREAM_MS))
              .then(async (again) => Buffer.from(await again.arrayBuffer()))
              .catch(() => body);
          }
          this.cache.set(this.#key(lane, seq), body);
          lane.next = seq + 1;
          this.#settle(lane, seq, null, body);
        } catch (err) {
          // Past the last segment: nothing more to make ahead.
          if (/out of range/.test(err.detail?.body || '')) lane.end = Math.min(lane.end, seq);
          lane.next = null;
          this.#settle(lane, seq, err.status ? err : httpError(502, `Serveur Stremio injoignable : ${err.message}`));
          this.log?.debug({ lane: lane.id, seq, err: err.message, detail: err.detail }, 'hls relay: segment failed');
          break;
        }
        // Someone waits for a segment outside this plan for too long: go to it.
        if (lane.waiters.some((w) => this.now() - w.at >= JUMP_AFTER_MS && !plan.includes(w.seq))) break;
      }
    })().finally(() => {
      lane.busy = false;
      setImmediate(() => this.#pump(lane));
    });
  }

  /**
   * Keeps the converters read recently alive while their film plays (isLive(sid)): Stremio
   * drops a converter after 2 min without a request, a room on pause included.
   */
  keepAlive(isLive) {
    const now = this.now();
    const seen = new Set();
    for (const lane of this.lanes.values()) {
      if (now - lane.lastUsed > KEEP_ALIVE_MS || !isLive(lane.sid) || seen.has(lane.params.convertId)) continue;
      seen.add(lane.params.convertId);
      // A playlist Stremio already has: no work for it, and the converter counts as used.
      this.upstream(lane.session, { ...lane.params, convertId: this.#id(lane.params.convertId) }, `${lane.track}.m3u8`, AbortSignal.timeout(10_000))
        .then((res) => res.body?.cancel().catch(() => {}))
        .catch(() => {});
    }
  }

  /** Forgets the films no room plays anymore (their converters are stopped by the sweep). */
  prune(liveSids) {
    for (const [id, lane] of this.lanes) {
      if (liveSids.has(lane.sid)) continue;
      for (const w of lane.waiters) w.reject(httpError(404, 'Vidéo terminée'));
      this.lanes.delete(id);
    }
    for (const [convertId, sid] of this.owners) {
      if (liveSids.has(sid)) continue;
      this.owners.delete(convertId);
      this.generations.delete(convertId);
      this.cache.dropPrefix(`${convertId}/`);
    }
  }
}
