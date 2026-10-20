// Public, sanitized diagnostics: is each dependency reachable from this server?
// Never includes full addon URLs: they can hold debrid keys (see maskAddon).

import { config } from './config.js';
import { describeFetchError, getJson } from './addons.js';

const CACHE_MS = 30_000;
// A well-known movie every catalog/stream addon should know (Interstellar).
const PROBE_MOVIE = 'tt0816692';

let cached = null;
const startedAt = new Date().toISOString();

/** Host plus a masked path, e.g. "torrentio.strem.fun/lang…(17)". */
export function maskAddon(base) {
  try {
    const u = new URL(base);
    const path = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return u.hostname;
    // Nothing of the path: some addons put the debrid key first.
    return `${u.hostname}/…(${path.length})`;
  } catch {
    return 'URL invalide';
  }
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, ...value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: publicError(err.message) };
  }
}

async function checkStremio() {
  return timed(async () => {
    const res = await fetch(`${config.stremioServerUrl}/settings`, { signal: AbortSignal.timeout(5000) }).catch(
      (err) => {
        throw new Error(describeFetchError(err, 5000));
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { values } = await res.json();
    return {
      version: values.serverVersion,
      transcodeConcurrency: values.transcodeConcurrency,
      hwaccel: values.transcodeHardwareAccel,
      cacheGb: values.cacheSize ? Math.round(values.cacheSize / 1024 ** 3) : values.cacheSize,
    };
  });
}

async function checkAddon(base, probe) {
  const manifest = await timed(async () => {
    const m = await getJson(`${base}/manifest.json`, 10_000);
    return { name: m.name, version: m.version, resources: (m.resources || []).map((r) => r.name || r) };
  });
  const result = { addon: maskAddon(base), manifest };
  if (probe) result[probe.label] = await timed(probe.run);
  return result;
}

let running = null;

/** Public page: the kind of error, without internal addresses or links (keys can be in them). */
function publicError(message) {
  return String(message || '')
    .replace(/https?:\/\/\S+/g, '[lien]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[adresse]')
    .replace(/\[[0-9a-f:]+\](?::\d+)?/gi, '[adresse]')
    .slice(0, 200);
}

/** One check at a time: callers that come during it share its result. */
export function diagnostics() {
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
  running ||= runDiagnostics().finally(() => (running = null));
  return running;
}

async function runDiagnostics() {
  const [stremioServer, metaAddon, streamAddons] = await Promise.all([
    checkStremio(),
    checkAddon(config.metaAddon, {
      label: 'search',
      run: async () => {
        const body = await getJson(`${config.metaAddon}/catalog/movie/top/search=interstellar.json`, 15_000);
        return { results: (body.metas || []).length };
      },
    }),
    Promise.all(
      config.streamAddons.map((base) =>
        checkAddon(base, {
          label: 'streams',
          run: async () => {
            const body = await getJson(`${base}/stream/movie/${PROBE_MOVIE}.json`, 20_000);
            return { results: (body.streams || []).length };
          },
        })
      )
    ),
  ]);
  const value = {
    ok: stremioServer.ok && metaAddon.manifest.ok && streamAddons.every((a) => a.streams?.ok),
    startedAt,
    checkedAt: new Date().toISOString(),
    browserMode: config.allowBrowserMode,
    discordConfigured: !!(config.discord.clientId && config.discord.clientSecret),
    stremioServer,
    metaAddon,
    streamAddonsConfigured: config.streamAddons.length,
    streamAddons,
  };
  cached = { value, expires: Date.now() + CACHE_MS };
  return value;
}

/** Logs one line per dependency, so the deploy logs show what works. */
export async function logDiagnostics(log) {
  const d = await diagnostics();
  const line = (ok) => (ok ? 'info' : 'warn');
  log[line(d.stremioServer.ok)]({ stremioServer: d.stremioServer }, 'diag: Stremio streaming server');
  log[line(d.metaAddon.manifest.ok)]({ metaAddon: d.metaAddon }, 'diag: meta addon');
  if (!d.streamAddons.length) log.warn('diag: no stream addon configured (STREAM_ADDON_URLS)');
  for (const a of d.streamAddons) {
    log[line(a.manifest.ok && a.streams?.ok)]({ streamAddon: a }, 'diag: stream addon');
  }
}
