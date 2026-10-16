// Turns an addon stream into something every viewer can play, using the Stremio
// streaming server: torrents are downloaded once by it, and its /hlsv2 converter
// produces HLS per quality profile (copy when the browser can decode the source,
// otherwise transcode, with AC3/DTS/TrueHD audio downmixed to AAC stereo).

import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;

/** Quality ladder. Width caps match what /hlsv2 understands (maxWidth). */
export const QUALITIES = [
  { id: '2160', label: '4K', maxWidth: 3840, estBitrate: 25_000_000 },
  { id: '1080', label: '1080p', maxWidth: 1920, estBitrate: 8_000_000 },
  { id: '720', label: '720p', maxWidth: 1280, estBitrate: 4_000_000 },
  { id: '480', label: '480p', maxWidth: 854, estBitrate: 1_800_000 },
];

// Video codecs every browser takes as-is from the converter (fMP4 segments). Others
// are added per viewer from their capabilities.
const BASE_VIDEO_CODECS = ['h264'];
// Audio is always made AAC/MP3 for everyone: it is cheap, and keeping a single audio
// variant means fewer distinct converters when many people watch.
const AUDIO_CODECS = ['aac', 'mp3'];

/** Profile path segment: quality id + capability letters, e.g. "2160hv". */
const CAP_LETTERS = { h: 'hevc', a: 'av1', v: 'vp9' };

export function parseProfile(profile) {
  const m = /^(\d{3,4})([hva]*)$/.exec(String(profile));
  if (!m) return null;
  const caps = {};
  for (const letter of m[2]) caps[CAP_LETTERS[letter]] = true;
  return { quality: m[1], caps };
}

const sessions = new Map();

async function stremio(path, init) {
  const res = await fetch(`${config.stremioServerUrl}${path}`, {
    ...init,
    signal: init?.signal || AbortSignal.timeout(60000),
  });
  return res;
}

/** Follows redirects (e.g. Torrentio → debrid CDN) so the converter hits the final file directly. */
async function resolveRedirects(url) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(20000),
    });
    res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status >= 400) throw new Error(`La source a répondu ${res.status}`);
    return current;
  }
  return current;
}

// Used when an addon gives an infoHash without trackers (e.g. TorrentsDB), so peers
// are found quickly instead of relying on DHT alone.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

export function peerSources(stream) {
  const infoHash = stream.infoHash.toLowerCase();
  if (Array.isArray(stream.sources) && stream.sources.length) return stream.sources;
  return [`dht:${infoHash}`, ...DEFAULT_TRACKERS.map((t) => `tracker:${t}`)];
}

async function resolveTorrent(stream) {
  const infoHash = stream.infoHash.toLowerCase();
  const sources = peerSources(stream);
  const res = await stremio(`/${infoHash}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      torrent: { infoHash },
      peerSearch: { sources, min: 40, max: 200 },
      ...(typeof stream.fileIdx === 'number' ? {} : { guessFileIdx: {} }),
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Le serveur Stremio n'a pas pu ouvrir le torrent (${res.status})`);
  const info = await res.json();

  let fileIdx = typeof stream.fileIdx === 'number' ? stream.fileIdx : info.guessedFileIdx;
  if (typeof fileIdx !== 'number' && Array.isArray(info.files) && info.files.length) {
    // Fall back to the largest file.
    fileIdx = info.files.reduce((best, f, i, all) => (f.length > all[best].length ? i : best), 0);
  }
  if (typeof fileIdx !== 'number') throw new Error('Aucun fichier vidéo dans ce torrent');
  return `${config.stremioSelfUrl}/${infoHash}/${fileIdx}`;
}

export async function probe(mediaURL) {
  const res = await stremio(`/hlsv2/probe?${new URLSearchParams({ mediaURL })}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Analyse du fichier impossible (${res.status})`);
  const video = body.streams.find((s) => s.track === 'video');
  return {
    duration: body.format?.duration || null,
    bitrate: body.format?.bitrate || video?.formatBitRate || null,
    video: video
      ? {
          codec: video.codec,
          width: video.width,
          height: video.height,
          hdr: !!video.isHdr,
          dolbyVision: !!video.isDoVi,
        }
      : null,
    audio: body.streams
      .filter((s) => s.track === 'audio')
      .map((s) => ({ codec: s.codec, channels: s.channels, language: s.language, title: s.title })),
  };
}

/** Resolves a stream to a media session shared by the whole room. */
export async function createSession(stream) {
  const mediaURL = stream.infoHash
    ? await resolveTorrent(stream)
    : await resolveRedirects(stream.url);
  const info = await probe(mediaURL);
  if (!info.video) throw new Error('Pas de piste vidéo dans ce fichier');

  const sid = randomBytes(16).toString('base64url');
  const session = { sid, mediaURL, info, lastUsed: Date.now() };
  sessions.set(sid, session);
  return session;
}

export function getSession(sid) {
  const s = sessions.get(sid);
  if (s) s.lastUsed = Date.now();
  return s || null;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [sid, s] of sessions) if (s.lastUsed < cutoff) sessions.delete(sid);
}, 30 * 60 * 1000).unref();

/** Qualities worth offering for this source (nothing above the source width). */
export function availableQualities(info) {
  const width = info.video?.width || 1920;
  const list = QUALITIES.filter((q) => q.maxWidth <= width * 1.05);
  // Always offer the smallest rung that holds the full source (e.g. 1080p for a 1600 px file).
  const native = [...QUALITIES].reverse().find((q) => q.maxWidth >= width) || QUALITIES[0];
  if (!list.includes(native)) list.unshift(native);
  return list.map(({ id, label, maxWidth, estBitrate }) => ({ id, label, maxWidth, estBitrate }));
}

/**
 * Converter parameters for one viewer profile. Viewers that end up with identical
 * parameters share the same converter id, so a quality is transcoded only once.
 *
 * @param info     probe result of the session
 * @param quality  one of QUALITIES ids
 * @param caps     { hevc, av1, vp9: boolean } what the viewer's browser can decode
 */
export function converterParams(sid, info, quality, caps = {}) {
  const q = QUALITIES.find((x) => x.id === quality);
  if (!q) return null;
  const codec = info.video.codec;
  const browserCodecs = [...BASE_VIDEO_CODECS, ...['hevc', 'av1', 'vp9'].filter((c) => caps[c])];
  const copy = browserCodecs.includes(codec) && info.video.width <= q.maxWidth * 1.05;

  const query = new URLSearchParams();
  // mediaURL is appended last by the relay; it never reaches the browser.
  if (copy) {
    query.append('videoCodecs', codec);
  } else {
    query.append('videoCodecs', 'h264');
    query.append('maxWidth', String(q.maxWidth));
    query.append('forceTranscoding', '1');
  }
  for (const a of AUDIO_CODECS) query.append('audioCodecs', a);
  query.append('maxAudioChannels', '2');

  return {
    // At most one copy + one per transcoded width per media (see transcode concurrency).
    convertId: `wp-${sid}-${copy ? `c-${codec}` : `t-${q.maxWidth}`}`,
    query,
    mode: copy ? 'copy' : 'transcode',
    outputWidth: copy ? info.video.width : Math.min(q.maxWidth, info.video.width),
  };
}

/**
 * Audio tracks get their own converter, one per track, shared by everyone who listens
 * to it. In a single converter, two viewers on two different tracks (VF and VO)
 * cancel each other's segments; separate converters don't.
 */
export function audioConverterParams(sid, info, track) {
  const n = Number(track);
  if (!Number.isInteger(n) || n < 0 || n > 31) return null;
  const query = new URLSearchParams();
  // Only audio is ever requested from it; the video codec is just the source's (no work).
  query.append('videoCodecs', info.video.codec);
  for (const a of AUDIO_CODECS) query.append('audioCodecs', a);
  query.append('maxAudioChannels', '2');
  return { convertId: `wp-${sid}-a${n}`, query, mode: 'audio' };
}

/** Which converter serves this relay path: audio paths go to their track's converter. */
export function hlsParams(sid, info, quality, caps, rest) {
  const audio = /^audio(\d+)(?:\.m3u8$|\/)/.exec(rest);
  if (audio) return QUALITIES.some((q) => q.id === quality) ? audioConverterParams(sid, info, audio[1]) : null;
  return converterParams(sid, info, quality, caps);
}

/** Public, browser-safe description of a session. */
export function publicMedia(session) {
  const { info } = session;
  return {
    sid: session.sid,
    duration: info.duration,
    source: info.video,
    audio: info.audio,
    qualities: availableQualities(info),
  };
}

// ---------------------------------------------------------------- HLS relay

// Only the converter's own resources can be requested through the relay.
const HLS_PATH_RE = /^(?:master|(?:video|audio|subtitle)\d+)\.m3u8$|^(?:video|audio)\d+\/init\.mp4$|^(?:video|audio)\d+\/segment\d+\.m4s$|^subtitle\d+\/segment\d+\.vtt$/;

export function isAllowedHlsPath(rest) {
  return HLS_PATH_RE.test(rest);
}

/**
 * The converter writes its full query (including mediaURL) into every URI of
 * its playlists. Strip it: the relay re-adds it server-side.
 */
export function rewritePlaylist(text) {
  return text
    .split('\n')
    .map((line) => {
      if (!line || line.startsWith('#')) {
        return line.replace(/URI="([^"?]*)\?[^"]*"/g, 'URI="$1"');
      }
      return line.replace(/\?.*$/, '');
    })
    .join('\n');
}

export async function fetchHls(session, params, rest, signal) {
  const query = new URLSearchParams(params.query);
  query.append('mediaURL', session.mediaURL);
  return stremio(`/hlsv2/${encodeURIComponent(params.convertId)}/${rest}?${query}`, {
    signal,
  });
}

/** Settings the watch party needs from the Stremio server (applied when STREMIO_AUTO_TUNE is on). */
export function wantedSettings(values) {
  const wanted = {};
  // One converter per quality must be able to live at the same time.
  if ((values.transcodeConcurrency || 1) < config.stremioTranscodeConcurrency) {
    wanted.transcodeConcurrency = config.stremioTranscodeConcurrency;
  }
  if (config.stremioCacheBytes && values.cacheSize !== null && values.cacheSize !== config.stremioCacheBytes) {
    wanted.cacheSize = config.stremioCacheBytes;
  }
  return wanted;
}

async function checkOnce(log) {
  const res = await stremio('/settings', { signal: AbortSignal.timeout(5000) });
  const { values } = await res.json();
  log.info(
    {
      version: values.serverVersion,
      hwaccel: values.transcodeHardwareAccel,
      profile: values.transcodeProfile,
      profiles: values.allTranscodeProfiles,
    },
    'Stremio streaming server reachable'
  );
  const wanted = wantedSettings(values);
  if (Object.keys(wanted).length === 0) return;
  if (!config.stremioAutoTune) {
    log.warn({ wanted }, 'Stremio server settings are not suited for several qualities at once (see README)');
    return;
  }
  const post = await stremio('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wanted),
    signal: AbortSignal.timeout(5000),
  });
  if (post.ok) log.info({ applied: wanted }, 'Stremio server settings updated');
  else log.warn({ status: post.status, wanted }, 'Could not update Stremio server settings');
}

/**
 * Checks (and tunes) the Stremio server in the background, retrying until it is up:
 * in a compose stack it may start after this backend.
 */
export function watchStremioServer(log) {
  let attempt = 0;
  const run = () =>
    checkOnce(log).catch((err) => {
      if (attempt++ % 6 === 0) {
        log.warn({ err: err.message }, `Stremio streaming server unreachable at ${config.stremioServerUrl}, retrying`);
      }
      setTimeout(run, 10_000).unref();
    });
  run();
}
