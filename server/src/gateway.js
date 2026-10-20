// Stremio-compatible streaming server for the Stremio apps themselves (Stremio Web, desktop,
// Android, TV: Settings → Streaming → streaming server URL = the site's address). Its routes
// sit at the root of the site's domain (index.js hands them over): stremio-video builds
// absolute paths ("/hlsv2/…", "/<infoHash>/<fileIdx>"), so a sub-path would not work.
//
// Torrents go to the Huwa engine (faster start, read-ahead, recovery), with the Stremio
// server's engine as fallback; everything else (HLS conversion, probe, subtitles, casting)
// goes to the private Stremio server, which reads Huwa's files over the internal network.
// No key: the owner asked for an open personal server. What it refuses instead: routes a
// Stremio client never calls, POST /settings, and URLs pointing into the private network
// (so the converter cannot be used to reach the other containers).
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const HASH = '[0-9a-fA-F]{40}';
const TORRENT_RE = new RegExp(`^/(${HASH})/(?:create|remove|stats\\.json|[^/]+(?:/stats\\.json)?)$`);
const STREMIO_RE = new RegExp(
  '^/(?:settings|stats\\.json|network-info|device-info|hwaccel-profiler|heartbeat|casting(?:/[^?]*)?' +
    '|hlsv2/[^?]+|subtitles\\.vtt|subtitlesTracks|opensubHash|subtitleSignature|embedded-ass[^?]*' +
    '|tracks/[^?]+|proxy/[^?]+|yt/[^?]+|ftp/[^?]+|(?:rar|zip|7zip|tgz|tar|nzb)/[^?]+)$',
);
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host',
  'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods',
  'access-control-expose-headers', 'access-control-allow-credentials', 'access-control-max-age',
]);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** Which upstream answers a path: torrent routes (with their info hash), Stremio, or none. */
export function routeOf(pathname) {
  if (pathname === '/create') return { to: 'torrent', hash: null };
  const t = TORRENT_RE.exec(pathname);
  if (t) return { to: 'torrent', hash: t[1].toLowerCase() };
  if (STREMIO_RE.test(pathname)) return { to: 'stremio' };
  return null;
}

/** A host on the internet (not loopback, private, link-local, or a bare container name). */
export function isPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (v === 6) return !(host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'));
  return host.includes('.');
}

/** Origin the client reached us at (behind Coolify's proxy: X-Forwarded-*). */
export function publicOrigin(headers) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const proto = first(headers['x-forwarded-proto']) || 'http';
  const host = first(headers['x-forwarded-host']) || first(headers.host) || '127.0.0.1:11470';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export function createGateway({ huwaUrl, huwaMediaUrl, stremioUrl, stremioSelfUrl, engine = 'huwa', log = console }) {
  /** Info hash → engine that holds it, for torrents opened through the gateway. */
  const engines = new Map();
  const engineOf = (hash) => engines.get(hash) || engine;
  const remember = (hash, e) => {
    engines.delete(hash);
    engines.set(hash, e);
    if (engines.size > 500) engines.delete(engines.keys().next().value);
  };
  const ownMedia = [huwaMediaUrl, stremioSelfUrl].map((u) => u.replace(/\/+$/, ''));
  const mediaPath = new RegExp(`^/${HASH}/\\d+$`);

  /**
   * A URL the client gave Stremio's converter (mediaURL, proxy target…): ours become the
   * internal address of the engine that holds the file; private-network ones are refused.
   */
  function rewriteTarget(value, origin) {
    let u;
    try {
      u = new URL(value);
    } catch {
      return value;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return value;
    if (u.origin === origin) {
      const m = /^\/([0-9a-fA-F]{40})\/\d+$/.exec(u.pathname);
      const base = m && engineOf(m[1].toLowerCase()) === 'huwa' ? huwaMediaUrl : stremioSelfUrl;
      return `${base.replace(/\/+$/, '')}${u.pathname}${u.search}`;
    }
    // The converter's own playlists carry the internal media URL back to the client.
    if (ownMedia.includes(u.origin) && mediaPath.test(u.pathname)) return value;
    if (!isPublicHost(u.hostname)) throw Object.assign(new Error('private address'), { status: 403 });
    return value;
  }

  function stremioPath(url, origin) {
    const parts = url.pathname.split('/');
    // /proxy/<d=origin&h=…>/<path>: the destination is inside the path.
    if (parts[1] === 'proxy' && parts[2]) {
      const q = new URLSearchParams(decodeURIComponent(parts[2]));
      if (q.get('d')) {
        q.set('d', new URL(rewriteTarget(q.get('d'), origin)).origin);
        parts[2] = encodeURIComponent(q.toString());
      }
    }
    const query = new URLSearchParams();
    for (const [k, v] of url.searchParams) query.append(k, /^https?:\/\//i.test(v) ? rewriteTarget(v, origin) : v);
    const qs = query.toString();
    return parts.join('/') + (qs ? `?${qs}` : '');
  }

  function forward(req, res, base, path, { body } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(path, base);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP.has(k) && !k.startsWith('x-forwarded') && k !== 'origin' && k !== 'referer' && k !== 'cookie') headers[k] = v;
      }
      if (body) headers['content-length'] = Buffer.byteLength(body);
      const lib = target.protocol === 'https:' ? https : http;
      const up = lib.request(target, { method: req.method, headers }, (upRes) => {
        if (upRes.statusCode >= 500 && body !== undefined && !res.headersSent) {
          upRes.resume();
          return reject(Object.assign(new Error(`upstream ${upRes.statusCode}`), { retry: true }));
        }
        const out = { ...CORS };
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) out[k] = v;
        res.writeHead(upRes.statusCode, out);
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('error', resolve);
      });
      res.on('close', () => up.destroy());
      up.on('error', (err) => reject(Object.assign(err, { retry: true })));
      if (body !== undefined) up.end(body);
      else req.pipe(up);
    });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        // A .torrent blob (hex) can be a few MB; nothing else is big.
        if (size > 16 * 1024 * 1024) reject(Object.assign(new Error('too large'), { status: 413 }));
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function torrent(req, res, url, hash) {
    const path = url.pathname + url.search;
    if (hash && req.method === 'GET' && url.pathname.endsWith('/stats.json') && engineOf(hash) === 'huwa') {
      return statsFromHuwa(res, path);
    }
    const order = hash ? [engineOf(hash)] : [engine];
    if (req.method === 'POST' && order[0] === 'huwa') order.push('stremio');
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    for (const [i, e] of order.entries()) {
      try {
        await forward(req, res, e === 'huwa' ? huwaUrl : stremioUrl, path, { body });
        if (hash && req.method === 'POST') remember(hash, e);
        return;
      } catch (err) {
        if (!err.retry || res.headersSent || i === order.length - 1) throw err;
        log.warn?.({ err: err.message, hash }, 'Huwa engine failed, gateway uses the Stremio torrent engine');
      }
    }
  }

  async function statsFromHuwa(res, path) {
    const r = await fetch(`${huwaUrl}${path}`, { signal: AbortSignal.timeout(8000) });
    const data = r.ok ? await r.json().catch(() => null) : null;
    return send(res, r.status, data && typeof data === 'object' ? stremioStats(data) : data);
  }

  async function settings(req, res, origin) {
    if (req.method === 'POST') {
      // Personal server, but the cache and transcoding settings stay Watch Party's.
      req.resume();
      return send(res, 200, { success: true });
    }
    let data;
    for (const base of [stremioUrl, huwaUrl]) {
      try {
        const r = await fetch(`${base}/settings`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          data = await r.json();
          break;
        }
      } catch {}
    }
    if (!data) return send(res, 502, { error: 'streaming server unavailable' });
    data.baseUrl = `${origin}/`;
    return send(res, 200, data);
  }

  return async function handle(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, { error: 'method not allowed' });
      const url = new URL(req.url, 'http://gateway');
      const origin = publicOrigin(req.headers);
      const route = routeOf(url.pathname);
      if (!route) return send(res, 404, { error: 'not found' });
      if (url.pathname === '/settings') return await settings(req, res, origin);
      if (route.to === 'torrent') return await torrent(req, res, url, route.hash);
      return await forward(req, res, stremioUrl, stremioPath(url, origin));
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (!err.status) log.warn?.({ err: err.message, url: req.url?.split('?')[0] }, 'gateway request failed');
      return send(res, err.status || 502, { error: err.status ? err.message : 'streaming server unavailable' });
    }
  };
}

const STATS_NUMBERS = ['downloadSpeed', 'uploadSpeed', 'downloaded', 'uploaded', 'unchoked', 'peers', 'queued', 'unique', 'connectionTries', 'swarmConnections', 'swarmSize'];

/**
 * Stremio apps drop a whole stats.json (peers, speed, progress stay at 0) unless every field of
 * their model is there, `opts` included, which Huwa leaves empty: fill in what is missing.
 */
export function stremioStats(data) {
  const out = { ...data, name: String(data.name ?? ''), infoHash: String(data.infoHash ?? '') };
  for (const k of STATS_NUMBERS) out[k] = Number.isFinite(data[k]) && data[k] >= 0 ? data[k] : 0;
  out.peerSearchRunning = Boolean(data.peerSearchRunning);
  out.swarmPaused = Boolean(data.swarmPaused);
  out.files = Array.isArray(data.files) ? data.files : [];
  // Each source needs lastStarted, numFound… and a valid url: none is better than a rejected one.
  out.sources = Array.isArray(data.sources)
    ? data.sources.filter((x) => x && typeof x.url === 'string' && typeof x.lastStarted === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(x.url))
    : [];
  const opts = data.opts && typeof data.opts === 'object' ? data.opts : {};
  out.opts = {
    connections: null, handshakeTimeout: null, timeout: null, path: '', dht: true, tracker: true, virtual: false,
    ...opts,
    growler: { flood: 0, pulse: null, ...opts.growler },
    peerSearch: { min: 0, max: 0, sources: [], ...opts.peerSearch },
    swarmCap: { maxSpeed: null, minPeers: null, ...opts.swarmCap },
  };
  return out;
}

function send(res, status, data) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
