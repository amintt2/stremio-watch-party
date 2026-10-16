// Client for the Stremio addon protocol: catalog search, meta and streams.
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

import { randomBytes } from 'node:crypto';
import { addonBase, config } from './config.js';

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

function preview(m) {
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    poster: m.poster || null,
    year: year(m),
    rating: m.imdbRating ? String(m.imdbRating) : null,
  };
}

export async function search(query) {
  const q = encodeURIComponent(query.trim());
  const results = await Promise.allSettled(
    ['movie', 'series'].map((type) =>
      getJson(`${config.metaAddon}/catalog/${type}/top/search=${q}.json`)
    )
  );
  const metas = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.metas || [] : []));
  return metas.map(preview);
}

const MANIFEST_TTL_MS = 60 * 60 * 1000;
let manifestCache = null;

async function metaManifest() {
  if (!manifestCache || manifestCache.expires < Date.now()) {
    const manifest = await getJson(`${config.metaAddon}/manifest.json`, 10000);
    manifestCache = { manifest, expires: Date.now() + MANIFEST_TTL_MS };
  }
  return manifestCache.manifest;
}

/**
 * Browsable catalogs of the meta addon, from its manifest. A catalog that requires an
 * extra other than "genre" (search, lastVideosIds…) can't be browsed. `home` = no
 * required extra at all, so it can be shown as a row on the home page.
 */
export function browsableCatalogs(manifest) {
  return (manifest?.catalogs || [])
    .filter((c) => ['movie', 'series'].includes(c.type) && typeof c.id === 'string')
    .map((c) => {
      const extra = Array.isArray(c.extra) ? c.extra : (c.extraSupported || []).map((name) => ({ name }));
      const required = extra.filter((e) => e.isRequired).map((e) => e.name);
      const genreExtra = extra.find((e) => e.name === 'genre');
      const genres = (genreExtra?.options || c.genres || []).filter((g) => typeof g === 'string');
      return {
        type: c.type,
        id: c.id,
        name: c.name || c.id,
        genres,
        genreRequired: required.includes('genre'),
        skip: extra.some((e) => e.name === 'skip'),
        required,
      };
    })
    .filter((c) => c.required.every((r) => r === 'genre') && (!c.genreRequired || c.genres.length))
    .map(({ required, ...c }) => ({ ...c, home: required.length === 0 }));
}

export async function catalogs() {
  return browsableCatalogs(await metaManifest());
}

export async function catalog(type, id, { genre, skip } = {}) {
  const def = (await catalogs()).find((c) => c.type === type && c.id === id);
  if (!def) throw Object.assign(new Error('Catalogue inconnu'), { statusCode: 404 });
  const extras = [];
  const g = genre && def.genres.includes(genre) ? genre : def.genreRequired ? def.genres[0] : null;
  if (g) extras.push(`genre=${encodeURIComponent(g)}`);
  const n = Math.max(0, Math.floor(Number(skip) || 0));
  if (n && def.skip) extras.push(`skip=${n}`);
  const path = `${config.metaAddon}/catalog/${type}/${encodeURIComponent(id)}${extras.length ? `/${extras.join('&')}` : ''}.json`;
  const body = await getJson(path);
  return { metas: (body.metas || []).filter((m) => m && m.id && m.name).map(preview), genre: g };
}

export async function meta(type, id) {
  const { meta: m } = await getJson(`${config.metaAddon}/meta/${type}/${encodeURIComponent(id)}.json`);
  if (!m) throw Object.assign(new Error('Fiche introuvable'), { statusCode: 404 });
  return normalizeMeta(m);
}

const YT_ID = /^[\w-]{6,20}$/;

/** "stremio:///detail/movie/tt123" → { type, id } (links of a meta object). */
function detailLink(url) {
  const m = /^stremio:\/\/\/detail\/(movie|series)\/([^/?#]+)/.exec(String(url || ''));
  if (!m) return null;
  try {
    return { type: m[1], id: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/** What the client needs from an addon meta object (also the extras: trailer, IMDb, similar). */
export function normalizeMeta(m) {
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const links = Array.isArray(m.links) ? m.links.filter((l) => l && typeof l === 'object') : [];
  const imdbId = [m.imdb_id, m.id].find((x) => typeof x === 'string' && /^tt\d+$/.test(x)) || null;
  const trailer =
    [...(Array.isArray(m.trailerStreams) ? m.trailerStreams.map((t) => t?.ytId) : []), ...(Array.isArray(m.trailers) ? m.trailers.map((t) => t?.source) : [])].find(
      (x) => typeof x === 'string' && YT_ID.test(x)
    ) || null;
  const similar = links
    .filter((l) => /similar|recommend|related/i.test(String(l.category || '')))
    .map((l) => ({ ...detailLink(l.url), name: typeof l.name === 'string' ? l.name : '' }))
    .filter((l) => l.id && l.name)
    .slice(0, 30);
  const byCategory = (re) => links.filter((l) => re.test(String(l.category || '')) && typeof l.name === 'string').map((l) => l.name);
  const writers = strings(m.writer).length ? strings(m.writer) : byCategory(/^writers?$/i);
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    poster: m.poster || null,
    background: m.background || null,
    logo: m.logo || null,
    description: m.description || '',
    year: year(m),
    releaseInfo: m.releaseInfo ? String(m.releaseInfo) : null,
    released: typeof m.released === 'string' ? m.released : null,
    runtime: m.runtime || null,
    rating: m.imdbRating ? String(m.imdbRating) : null,
    genres: strings(m.genres || m.genre),
    cast: strings(m.cast).slice(0, 12),
    director: strings(m.director).slice(0, 4),
    writers: writers.slice(0, 4),
    country: typeof m.country === 'string' ? m.country : null,
    awards: typeof m.awards === 'string' ? m.awards : null,
    status: typeof m.status === 'string' ? m.status : null,
    imdbId,
    trailer,
    similar,
    videos: (m.videos || [])
      .filter((v) => typeof v.season === 'number' && typeof v.episode === 'number')
      .map((v) => ({
        id: v.id,
        season: v.season,
        episode: v.episode,
        title: v.name || v.title || `Épisode ${v.episode}`,
        released: v.released || v.firstAired || null,
        thumbnail: v.thumbnail || null,
        overview: typeof v.overview === 'string' ? v.overview.slice(0, 600) : null,
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

/**
 * Checks a user-supplied stream addon before saving it: https only (http allowed for
 * localhost in browser test mode), and its manifest must offer streams.
 */
export async function inspectStreamAddon(url, { allowHttp = false } = {}) {
  const base = addonBase(url);
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw Object.assign(new Error('URL invalide'), { statusCode: 400 });
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw Object.assign(new Error("L'addon doit être en https"), { statusCode: 400 });
  }
  let manifest;
  try {
    manifest = await getJson(`${base}/manifest.json`, 10000);
  } catch (err) {
    throw Object.assign(new Error(`Manifest illisible (${err.message})`), { statusCode: 400 });
  }
  const resources = (manifest.resources || []).map((r) => (typeof r === 'string' ? r : r?.name));
  if (!resources.includes('stream')) {
    throw Object.assign(new Error("Cet addon ne fournit pas de sources"), { statusCode: 400 });
  }
  return { base, name: String(manifest.name || parsed.hostname).slice(0, 100) };
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

/**
 * Audio languages announced by the release name / addon text:
 * MULTI (VF + VO), VF (French audio), VOSTFR (original + French subs).
 */
export function streamLanguages(text) {
  const t = ` ${text} `;
  const out = [];
  const multi = /[\s._\-[(](multi|dual[\s._-]?audio|multi[\s._-]?audio)[\s._\-\])]/i.test(t);
  const vostfr = /[\s._\-[(](vostfr|subfrench|stfr)[\s._\-\])]/i.test(t);
  const vf = /[\s._\-[(](vff|vfq|vfi|vf2|vf|truefrench|french)[\s._\-\])]/i.test(t) || t.includes('🇫🇷');
  if (multi) out.push('MULTI');
  if (vf && !vostfr) out.push('VF');
  if (vostfr) out.push('VOSTFR');
  return out;
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
    languages: streamLanguages(text),
    kind: stream.infoHash ? 'torrent' : 'http',
  };
}

function isPlayable(stream) {
  if (stream.infoHash && /^[a-f0-9]{40}$/i.test(stream.infoHash)) return true;
  return typeof stream.url === 'string' && /^https?:\/\//i.test(stream.url);
}

/** `extraBases`: the user's own addons (already normalized with addonBase). */
export async function streams(type, id, log, extraBases = []) {
  const bases = [...new Set([...config.streamAddons, ...extraBases])];
  const perAddon = await Promise.allSettled(
    bases.map(async (base) => {
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
      host = new URL(bases[i]).hostname;
    } catch {}
    log?.warn({ addon: host, err: r.reason?.message }, 'stream addon failed');
  });
  return { streams: list, failedAddons: failed };
}
