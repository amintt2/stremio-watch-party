// Automatic source choice, like Huwa: nobody picks a source by hand. The sources are ranked
// (language, instant debrid links, quality, seeders), then the best torrents are probed in
// parallel by the Huwa engine (metadata + peers answering a handshake, never a piece) and the
// first healthy swarm wins instead of starting one torrent at a time. Direct links (debrid)
// answer a 1-byte request first. If the winner then fails to open, the next one is tried.
//
// The decision rules are Huwa's (src/torrent/peer-race.ts), with server time budgets.

import { readFileSync, writeFileSync } from 'node:fs';
import { describeStream, guardedFetch, lookupStream } from './addons.js';
import { peerSources } from './media.js';

/** Answering peers that make a swarm "healthy". */
export const MIN_CONNECTED = 3;
/** Engine-side probe deadline. */
export const PROBE_TIMEOUT_MS = 5000;
/** No healthy swarm by then: the best one with an answering peer wins. */
export const SOFT_COMMIT_MS = 2000;
/** Hard deadline: the best playable swarm, else the plain ranking. */
export const RACE_DEADLINE_MS = 3500;
/** Every candidate still weak by then: more are probed. */
export const WIDEN_AFTER_MS = 1000;
export const POLL_MS = 200;
/** A healthy torrent in a worse language waits this long for a better-language one. */
export const LANG_GRACE_MS = 500;
/** Torrents probed at first, then at most (obscure titles). */
export const FIRST_WIDTH = 5;
export const MAX_WIDTH = 10;
/** Direct links: how long a 1-byte request may take. */
const HTTP_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------- ranking

const QUALITY_RANK = { '1080p': 4, '720p': 3, '4K': 2, '1440p': 2, '480p': 1 };

/**
 * 0 when the source speaks what the starter wants: MULTI always; VF for "fr"; for "vo",
 * anything that isn't French-only. 1 otherwise. No preference: MULTI first anyway.
 */
export function languageScore(languages = [], want = null) {
  if (languages.includes('MULTI')) return 0;
  if (want === 'fr') return languages.includes('VF') ? 0 : 1;
  if (want === 'vo') return languages.includes('VF') && !languages.includes('VOSTFR') ? 1 : 0;
  return 1;
}

/**
 * Sources in preference order: language, then instant (debrid cached / direct links), then
 * quality (1080p first: 4K is heavy for everyone), then seeders. Too-big torrents are dropped.
 */
export function rankSources(described, want = null) {
  const key = (s) => [
    languageScore(s.languages, want),
    s.cached ? 0 : s.kind === 'http' ? 1 : 2,
    -(QUALITY_RANK[s.quality || ''] || 0),
    -(s.seeders ?? -1),
  ];
  return described
    .filter((s) => !s.tooBig)
    .map((s, i) => ({ s, k: key(s), i }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
      return a.i - b.i;
    })
    .map(({ s }) => s);
}

// ---------------------------------------------------------------- torrent race (Huwa rules)

const PENDING = ['queued', 'resolving'];
const isPending = (p) => !!p && PENDING.includes(p.state);
const playable = (p) => !!p && (p.state === 'healthy' || p.state === 'weak' || p.local || (p.state === 'resolving' && p.fileIdx != null));
const BIG_PIECE_BYTES = 8 * 1024 * 1024;
const bigPieces = (c) => (c.probe?.pieceLength ?? 0) >= BIG_PIECE_BYTES;

function first(cands) {
  let best;
  for (const c of cands) if (!best || c.lang < best.lang || (c.lang === best.lang && bigPieces(best) && !bigPieces(c))) best = c;
  return best;
}

function bestSlow(cands) {
  return cands.reduce((a, b) => {
    if (b.lang !== a.lang) return b.lang < a.lang ? b : a;
    if (b.probe.connected !== a.probe.connected) return b.probe.connected > a.probe.connected ? b : a;
    if (bigPieces(a) !== bigPieces(b)) return bigPieces(a) ? b : a;
    if (b.probe.peers !== a.probe.peers) return b.probe.peers > a.probe.peers ? b : a;
    return a;
  });
}

function nextCheckpoint(elapsed, deadline, soft) {
  const next = [WIDEN_AFTER_MS, soft, deadline].filter((t) => t > elapsed);
  return Math.max(50, (next.length ? Math.min(...next) : deadline) - elapsed);
}

/**
 * `cands`: [{ key, lang, probe? }] in preference order. Returns { key, why } to commit,
 * { key: null, waitMs } to keep waiting, or { key: null, exhausted: true }.
 */
export function decidePeerRace(cands, elapsed, deadline = RACE_DEADLINE_MS, soft = SOFT_COMMIT_MS) {
  const probed = cands.filter((c) => c.probe && c.probe.state !== 'cancelled');
  if (!probed.length) return cands.some((c) => c.probe) ? { key: null, exhausted: true } : { key: null, waitMs: nextCheckpoint(elapsed, deadline, soft) };
  const local = first(probed.filter((c) => c.probe.local));
  if (local) return { key: local.key, why: 'local' };
  const pending = probed.filter((c) => isPending(c.probe));
  const late = elapsed >= deadline;
  const healthy = probed.filter((c) => c.probe.state === 'healthy');
  const best = first(healthy);
  if (best) {
    const better = pending.some((c) => c.lang < best.lang);
    const firstAt = Math.min(...healthy.filter((c) => c.lang === best.lang).map((c) => c.probe.doneAtMs ?? elapsed));
    const until = Math.min(firstAt + LANG_GRACE_MS, deadline);
    if (better && !late && elapsed < until) return { key: null, waitMs: Math.max(50, until - elapsed) };
    return { key: best.key, why: 'healthy' };
  }
  const weak = probed.filter((c) => playable(c.probe));
  const answering = weak.filter((c) => c.probe.connected > 0);
  if (pending.length && !late && elapsed >= soft && answering.length) return { key: bestSlow(answering).key, why: 'best' };
  if (pending.length && !late) return { key: null, waitMs: nextCheckpoint(elapsed, deadline, soft) };
  if (!weak.length) return { key: null, exhausted: true };
  return { key: bestSlow(weak).key, why: 'best' };
}

/** Every candidate weak after WIDEN_AFTER_MS (or all done without a healthy one): probe more. */
export function shouldWiden(probes, elapsed) {
  const list = probes.filter((p) => p && p.state !== 'cancelled');
  if (!list.length) return false;
  if (list.some((p) => p.state === 'healthy' || p.local || p.connected >= MIN_CONNECTED)) return false;
  return elapsed >= WIDEN_AFTER_MS || list.every((p) => !isPending(p));
}

/** Nothing playable: the probed torrent with the most answering peers, else null. */
export function afterExhausted(cands) {
  const answering = cands.filter((c) => c.probe && c.probe.state !== 'cancelled' && c.probe.connected > 0 && c.probe.state !== 'noFile');
  return answering.length ? bestSlow(answering).key : null;
}

// ---------------------------------------------------------------- Huwa engine client

/**
 * Probe API of Huwa Server (/api/v1/engine/probe*). One session for the whole backend, kept
 * in `file` across restarts (Huwa limits sessions per address and keeps them for weeks).
 */
export class HuwaProbes {
  constructor(baseUrl, { file = null, fetchImpl = fetch } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.file = file;
    this.token = null;
    this.creating = null;
    try {
      if (file) this.token = JSON.parse(readFileSync(file, 'utf8')).token || null;
    } catch {}
  }

  /** Concurrent callers share one session request. */
  #session() {
    this.creating ||= (async () => {
      const res = await this.fetch(`${this.base}/api/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Huwa session ${res.status}`);
      this.token = (await res.json()).token;
      try {
        if (this.file) writeFileSync(this.file, JSON.stringify({ token: this.token }), { mode: 0o600 });
      } catch {}
    })().finally(() => (this.creating = null));
    return this.creating;
  }

  async call(method, args, retry = true) {
    if (!this.token) await this.#session();
    const res = await this.fetch(`${this.base}/api/v1/engine/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.call(method, args, false);
    }
    if (!res.ok) throw new Error(`Huwa ${method} ${res.status}`);
    return res.json();
  }

  start(req) {
    return this.call('probeStart', req);
  }

  statuses(ids) {
    return this.call('probeStatus', { ids });
  }

  cancel(ids) {
    return ids.length ? this.call('probeCancel', { ids }).catch(() => {}) : Promise.resolve();
  }
}

/**
 * Races torrents. `cands`: [{ key, lang, stream }] in preference order.
 * Returns { key, why, probes } (key null: nothing better than the plain ranking).
 */
export async function raceTorrents(cands, probes, { episode = null, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log } = {}) {
  const t0 = now();
  const byId = new Map();
  const state = new Map(); // key → probe status (+ doneAtMs)
  let width = Math.min(FIRST_WIDTH, cands.length);
  let widened = false;
  const startProbe = async (c) => {
    const s = c.stream;
    try {
      const res = await probes.start({
        infoHash: s.infoHash.toLowerCase(),
        sources: peerSources(s),
        name: s.title?.split('\n')[0] || undefined,
        fileIdx: typeof s.fileIdx === 'number' ? s.fileIdx : undefined,
        filename: s.behaviorHints?.filename || undefined,
        episode: episode ?? undefined,
        timeoutMs: PROBE_TIMEOUT_MS,
        minPeers: MIN_CONNECTED,
      });
      byId.set(res.id, c.key);
      state.set(c.key, { ...res, state: res.state || 'queued' });
    } catch (err) {
      state.set(c.key, { state: 'failed', peers: 0, connected: 0 });
      log?.debug({ err: err.message }, 'probe start failed');
    }
  };
  await Promise.all(cands.slice(0, width).map(startProbe));
  let decision;
  try {
    for (;;) {
      const elapsed = now() - t0;
      const view = cands.map((c) => ({ key: c.key, lang: c.lang, probe: state.get(c.key) }));
      decision = decidePeerRace(view.filter((v) => v.probe), elapsed);
      if (decision.key) break;
      if (!widened && width < Math.min(MAX_WIDTH, cands.length) && (shouldWiden([...state.values()], elapsed) || decision.exhausted)) {
        widened = true;
        const more = cands.slice(width, Math.min(MAX_WIDTH, cands.length));
        width += more.length;
        await Promise.all(more.map(startProbe));
        continue;
      }
      if (decision.exhausted || elapsed > RACE_DEADLINE_MS + 2000) {
        decision = { key: afterExhausted(view), why: 'best' };
        break;
      }
      await sleep(Math.min(POLL_MS, decision.waitMs ?? POLL_MS));
      const ids = [...byId.keys()];
      if (!ids.length) continue;
      const list = await probes.statuses(ids).catch(() => []);
      for (const st of Array.isArray(list) ? list : []) {
        const key = byId.get(st.id);
        if (!key) continue;
        const prev = state.get(key);
        const done = !PENDING.includes(st.state);
        state.set(key, { ...st, doneAtMs: done ? (prev?.doneAtMs ?? now() - t0) : undefined });
      }
    }
  } finally {
    await probes.cancel([...byId.keys()]);
  }
  return { key: decision.key, why: decision.why, probes: Object.fromEntries(state) };
}

/** Direct links: the first of the best few to answer a 1-byte request (better rank wins ties). */
export async function raceHttp(cands, { fetchImpl = guardedFetch, graceMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const top = cands.slice(0, 3);
  if (!top.length) return null;
  const t0 = Date.now();
  // undefined while pending, then { ok, at }.
  const results = top.map(() => undefined);
  top.forEach((c, i) => {
    fetchImpl(c.stream.url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      .then((res) => {
        res.body?.cancel?.().catch(() => {});
        results[i] = { ok: res.status === 200 || res.status === 206, at: Date.now() };
      })
      .catch(() => (results[i] = { ok: false, at: Date.now() }));
  });
  for (;;) {
    await sleep(25);
    const ok = results.findIndex((r) => r?.ok);
    if (ok === 0 || results.every((r) => r !== undefined) || Date.now() - t0 > HTTP_TIMEOUT_MS) break;
    // A worse-ranked link answered: the better ones get a short grace, unless they already failed.
    if (ok > 0 && (results.slice(0, ok).every((r) => r !== undefined) || Date.now() - results[ok].at >= graceMs)) break;
  }
  const i = results.findIndex((r) => r?.ok);
  return i >= 0 ? { key: top[i].key, ms: results[i].at - t0 } : null;
}

/**
 * The order to try sources in: the race winner first, then the rest of the ranking.
 * `keys`: stream keys the client offered (or the addons' list). Returns
 * { order: [{ key, stream, described }], winner, why, tested }.
 */
export async function chooseSources(keys, { want = null, probes = null, episode = null, log } = {}) {
  const all = keys
    .map((key) => {
      const stream = lookupStream(key);
      return stream ? { key, stream, described: { ...describeStream(stream, ''), key } } : null;
    })
    .filter(Boolean);
  const ranked = rankSources(all.map((x) => x.described), want).map((d) => all.find((x) => x.key === d.key));
  if (!ranked.length) return { order: [], winner: null, why: 'none', tested: 0 };
  const lang = (x) => languageScore(x.described.languages, want);
  const head = ranked[0];
  let winner = null;
  let why = 'rank';
  let tested = 0;
  if (head.stream.url) {
    // An instant link is ranked first: check it (and the next direct ones) answer.
    const http = ranked.filter((x) => x.stream.url && lang(x) === lang(head));
    tested = Math.min(3, http.length);
    const res = await raceHttp(http).catch(() => null);
    if (res) [winner, why] = [res.key, 'http'];
  }
  let health = {};
  if (!winner && probes) {
    const torrents = ranked.filter((x) => x.stream.infoHash).map((x) => ({ key: x.key, lang: lang(x), stream: x.stream }));
    if (torrents.length) {
      try {
        const res = await raceTorrents(torrents, probes, { episode, log });
        tested = Object.keys(res.probes).length;
        health = res.probes;
        if (res.key) [winner, why] = [res.key, res.why];
      } catch (err) {
        log?.warn({ err: err.message }, 'torrent race failed, plain ranking');
      }
    }
  }
  // After the winner: swarms that answered, then the ones not probed, dead ones last (each
  // dead torrent would cost a long timeout before the next try).
  const tier = (x) => {
    const p = health[x.key];
    if (!p) return 1;
    if (p.local || p.connected > 0 || p.state === 'healthy') return 0;
    return p.state === 'failed' || p.state === 'noFile' || p.state === 'weak' ? 2 : 1;
  };
  const rest = ranked.filter((x) => x.key !== winner).sort((a, b) => tier(a) - tier(b));
  const order = winner ? [ranked.find((x) => x.key === winner), ...rest] : rest;
  return { order, winner: order[0].key, why, tested };
}
