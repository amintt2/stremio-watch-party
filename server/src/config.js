// All configuration comes from the environment (see .env.example).

function list(value) {
  return (value || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function trimSlash(url) {
  return (url || '').replace(/\/+$/, '');
}

/**
 * Base URL of an addon (resource URLs are built from it). Accepts the manifest URL,
 * a stremio:// link, or a Stremio web share link (…?addon=<encoded manifest URL>).
 */
export function addonBase(url) {
  let u = (url || '').trim();
  const shared = /[?&]addon=([^&#]+)/.exec(u);
  if (shared) u = decodeURIComponent(shared[1]);
  u = u.replace(/^stremio:\/\//i, 'https://');
  return trimSlash(trimSlash(u).replace(/\/manifest\.json$/, ''));
}

export const config = {
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || '0.0.0.0',

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  },

  // Signs session tokens. Must be set in production.
  sessionSecret: process.env.SESSION_SECRET || '',

  // Public address of the site, e.g. https://watch.mciut.fr: web login redirect URI and
  // links opened outside the Discord iframe. Default: the request's scheme + host.
  publicUrl: trimSlash(process.env.PUBLIC_URL || ''),

  // SQLite database (accounts, progress, library). Mount it as a volume in Docker.
  dataDir: process.env.DATA_DIR || './data',

  // Lets the app run in a normal browser tab (no Discord), for local testing.
  allowBrowserMode: process.env.ALLOW_BROWSER_MODE === '1',

  // Shown on /conditions and /confidentialite (required by Discord for apps).
  legal: {
    appName: process.env.APP_NAME || 'Watch Party',
    // Who runs this instance, e.g. the community / server name.
    operator: process.env.LEGAL_OPERATOR || 'l’équipe d’administration de la communauté',
    // How to reach the operator: an email or a link (Discord server invite, ticket channel…).
    contact: process.env.LEGAL_CONTACT || '',
  },

  // Where this backend reaches the Stremio streaming server.
  stremioServerUrl: trimSlash(process.env.STREMIO_SERVER_URL || 'http://127.0.0.1:11470'),
  // Base URL the Stremio server uses to read torrents from itself (it fetches its own
  // /{infoHash}/{fileIdx} endpoint when transcoding). Defaults to its loopback address.
  stremioSelfUrl: trimSlash(process.env.STREMIO_SELF_URL || 'http://127.0.0.1:11470'),
  // Apply the settings below to the Stremio server at startup (STREMIO_AUTO_TUNE=0 to disable).
  stremioAutoTune: process.env.STREMIO_AUTO_TUNE !== '0',
  stremioTranscodeConcurrency: Number(process.env.STREMIO_TRANSCODE_CONCURRENCY || 6),
  stremioCacheBytes: process.env.STREMIO_CACHE_GB
    ? Math.round(Number(process.env.STREMIO_CACHE_GB) * 1024 ** 3)
    : null,

  // Catalog/metadata addon (search + movie/series details).
  metaAddon: addonBase(process.env.META_ADDON_URL || 'https://v3-cinemeta.strem.io/manifest.json'),
  // Stream addons (e.g. your Torrentio configuration URL). These URLs can contain
  // debrid API keys: they never leave the server.
  streamAddons: list(process.env.STREAM_ADDON_URLS).map(addonBase),

  // Hosts the image proxy may fetch posters/avatars from (the Discord iframe can't
  // load third-party images directly).
  imageHosts: list(
    process.env.IMAGE_HOSTS ||
      'images.metahub.space,live.metahub.space,episodes.metahub.space,image.tmdb.org,m.media-amazon.com,cdn.discordapp.com'
  ),
};

export function assertConfig(log) {
  if (!config.sessionSecret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET is required in production');
    }
    config.sessionSecret = 'dev-only-insecure-secret';
    log.warn('SESSION_SECRET not set: using an insecure development secret');
  }
  if (!config.discord.clientId || !config.discord.clientSecret) {
    log.warn('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set: Discord login is disabled');
  }
  if (config.streamAddons.length === 0) {
    log.warn('STREAM_ADDON_URLS is empty: no stream sources configured');
  }
}
