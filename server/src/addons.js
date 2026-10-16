// Client for the Stremio addon protocol: catalog search, meta and streams.
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const STREAM_CACHE_TTL_MS = 60 * 60 * 1000;

/** Readable reason for a failed fetch ("timeout after 15 s", "ENOTFOUND", "HTTP 403"…). */
export function describeFetchError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timeout after ${timeoutMs / 1000} s`;
  const cause = err?.cause;
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ''}`;
  return err?.message || String(err);
}

export async function getJson(url, timeoutMs = 15000) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'WatchParty/0.1 (Stremio addon client)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(describeFetchError(err, timeoutMs));
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    const server = res.headers.get('server');
    throw new Error(`HTTP ${res.status}${server ? ` (${server})` : ''}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error('réponse invalide (pas du JSON)');
  }
}

// ---------------------------------------------------------------- catalog / meta

function year(meta) {
  const y = meta.releaseInfo || meta.year || '';
  return String(y).slice(0, 4) || null;
}

export async function search(query) {
  const q = encodeURIComponent(query.trim());
  const results = await Promise.allSettled(
    ['movie', 'series'].map((type) =>
      getJson(`${config.metaAddon}/catalog/${type}/top/search=${q}.json`)
    )
  );
  const metas = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.metas || [] : []));
  return metas.map((m) => ({
    id: m.id,
    type: m.type,
    name: m.name,
    poster: m.poster || null,
    year: year(m),
  }));
}

export async function meta(type, id) {
  const { meta: m } = await getJson(`${config.metaAddon}/meta/${type}/${encodeURIComponent(id)}.json`);
  if (!m) throw new Error('Introuvable');
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    poster: m.poster || null,
    background: m.background || null,
    description: m.description || '',
    year: year(m),
    runtime: m.runtime || null,
    videos: (m.videos || [])
      .filter((v) => typeof v.season === 'number' && typeof v.episode === 'number')
      .map((v) => ({
        id: v.id,
        season: v.season,
        episode: v.episode,
        title: v.name || v.title || `Épisode ${v.episode}`,
        released: v.released || null,
      }))
      .sort((a, b) => a.season - b.season || a.episode - b.episode),
  };
}

// ---------------------------------------------------------------- streams

const addonNames = new Map();

async function addonName(base) {
  if (!addonNames.has(base)) {
    const name = await getJson(`${base}/manifest.json`, 8000)
      .then((m) => m.name)
      .catch(() => null);
    addonNames.set(base, name || new URL(base).hostname);
  }
  return addonNames.get(base);
}

/** Full stream objects (may contain debrid URLs/keys) stay server-side, keyed by an opaque id. */
const streamCache = new Map();

function remember(stream) {
  const key = randomBytes(12).toString('base64url');
  streamCache.set(key, { stream, expires: Date.now() + STREAM_CACHE_TTL_MS });
  return key;
}

export function lookupStream(key) {
  const entry = streamCache.get(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.stream;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of streamCache) if (entry.expires < now) streamCache.delete(key);
}, 10 * 60 * 1000).unref();

const QUALITY_RE = /\b(2160p|4k|uhd|1440p|1080p|720p|576p|480p|360p)\b/i;

function normalizeQuality(raw) {
  if (!raw) return null;
  const q = raw.toLowerCase();
  if (q === '4k' || q === 'uhd' || q === '2160p') return '4K';
  return q;
}

/** Turns an addon stream into what the browser may see (no URLs, no keys). */
export function describeStream(stream, addon) {
  const name = String(stream.name || '');
  const title = String(stream.title || stream.description || '');
  const text = `${name}\n${title}`;
  const seeders = text.match(/👤\s*(\d+)/u);
  const size = text.match(/💾\s*([\d.,]+\s*[KMGT]i?B)/iu);
  const origin = text.match(/⚙️\s*([^\n]+)/u);
  const quality = text.match(QUALITY_RE);
  // First line of the title is usually the release/file name.
  const release = title.split('\n')[0].trim() || stream.behaviorHints?.filename || name;

  return {
    addon,
    label: name.split('\n')[0].trim() || addon,
    release,
    quality: normalizeQuality(quality?.[1]),
    seeders: seeders ? Number(seeders[1]) : null,
    size: size ? size[1].replace(',', '.') : null,
    origin: origin ? origin[1].trim() : null,
    hdr: /\b(hdr10\+?|hdr|dv|dovi|dolby\s?vision)\b/i.test(text),
    dolbyVision: /\b(dv|dovi|dolby\s?vision)\b/i.test(text),
    hevc: /\b(hevc|x265|h\.?265)\b/i.test(text),
    // Debrid-cached links (e.g. "[RD+]") start instantly and don't touch P2P.
    cached: /\[[A-Z]{2,3}\+\]/.test(name),
    kind: stream.infoHash ? 'torrent' : 'http',
  };
}

function isPlayable(stream) {
  if (stream.infoHash && /^[a-f0-9]{40}$/i.test(stream.infoHash)) return true;
  return typeof stream.url === 'string' && /^https?:\/\//i.test(stream.url);
}

export async function streams(type, id, log) {
  const perAddon = await Promise.allSettled(
    config.streamAddons.map(async (base) => {
      const [name, body] = await Promise.all([
        addonName(base),
        getJson(`${base}/stream/${type}/${encodeURIComponent(id)}.json`, 20000),
      ]);
      return (body.streams || []).filter(isPlayable).map((s) => ({
        key: remember(s),
        ...describeStream(s, name),
      }));
    })
  );
  const list = perAddon.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  let failed = 0;
  perAddon.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    failed++;
    // Host only: the full addon URL may carry a debrid key.
    let host = 'invalid addon URL';
    try {
      host = new URL(config.streamAddons[i]).hostname;
    } catch {}
    log?.warn({ addon: host, err: r.reason?.message }, 'stream addon failed');
  });
  return { streams: list, failedAddons: failed };
}
