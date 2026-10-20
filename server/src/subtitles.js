// External subtitles from Stremio subtitle addons (OpenSubtitles v3 by default).
// The browser gets an opaque key per subtitle and asks for its cues by key: addon
// and file URLs stay on the server. Each viewer picks their own language.

import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { safeFetch } from './netguard.js';

const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PER_LANG = 8;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------- parsing

function seconds(stamp) {
  // 00:01:02,500 | 00:01:02.500 | 01:02.500
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(stamp.trim());
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/**
 * Keeps only <i>, <b>, <u> (lower-cased, no attributes); everything else that looks
 * like markup ({\an8}, <font color>, stray <) is dropped or escaped.
 */
export function cleanCueText(text) {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(\/?)([ibu])\s*>/gi, (_, slash, tag) => `\u0001${slash}${tag.toLowerCase()}\u0002`)
    .replace(/<[^<>]*>/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** SRT or WebVTT text → [{ start, end, text }] sorted by start. */
export function parseSubtitles(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = seconds(a);
    const end = seconds((b || '').trim().split(/\s+/)[0] || '');
    if (start === null || end === null || end <= start) continue;
    const body = cleanCueText(lines.slice(i + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Bytes → text: UTF-8, or Windows-1252 when the file clearly isn't UTF-8. */
export function decodeSubtitle(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const broken = (utf8.match(/�/g) || []).length;
  if (broken > 2) return new TextDecoder('windows-1252').decode(buffer);
  return utf8;
}

// ---------------------------------------------------------------- addons

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** opaque key -> { url, expires } */
const files = new Map();
/** opaque key -> cues (small LRU) */
const cueCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, f] of files) if (f.expires < now) files.delete(key);
}, 30 * 60 * 1000).unref();

/** Release tokens: "Dune.Part.Two.2024.1080p.WEB-DL.H264-GRP.mkv" → dune, part, two, 2024, 1080p, web, dl… */
export function releaseTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|webm|m4v|ts|srt|ass|ssa|vtt|sub)$/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^(the|and|sub|subs|vostfr|en|fr|eng|fre)$/.test(t));
}

/**
 * The subtitle was made for a release that looks like the playing file: same title,
 * source, resolution and group usually means the same cut and the same timing.
 */
export function sameRelease(subName, videoName) {
  const a = new Set(releaseTokens(subName));
  const b = releaseTokens(videoName);
  if (!a.size || !b.length) return false;
  const common = b.filter((t) => a.has(t)).length;
  return common >= 3 && common / Math.max(a.size, b.length) >= 0.6;
}

/** 'hash': made for this exact file; 'release': for the same release name; null otherwise. */
export function matchOf(sub, video) {
  if (sub.m === 'h' || sub.hashMatch === true) return 'hash';
  if (video?.name && sameRelease(sub.movieReleaseName || sub.subtitleFileName || sub.release, video.name)) return 'release';
  return null;
}

/**
 * Files matching the video first (hash, then release name), then French, English and
 * the rest by name; a few per language.
 */
export function rankSubtitles(list, video = null, preferred = ['fre', 'fra', 'fr', 'eng', 'en']) {
  const rank = (lang) => {
    const i = preferred.indexOf(lang);
    return i < 0 ? preferred.length : i;
  };
  const tier = (m) => (m === 'hash' ? 0 : m === 'release' ? 1 : 2);
  const perLang = new Map();
  return list
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && typeof s.lang === 'string')
    .map((s, i) => ({ ...s, match: matchOf(s, video), i }))
    .sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang) || tier(a.match) - tier(b.match) || a.i - b.i)
    .filter((s) => {
      const n = (perLang.get(s.lang) || 0) + 1;
      perLang.set(s.lang, n);
      return n <= MAX_PER_LANG;
    });
}

/** Stremio "extra" path segment describing the played file (hash, size, name). */
export function videoExtra(video) {
  const params = new URLSearchParams();
  if (video?.hash) params.set('videoHash', video.hash);
  if (video?.size) params.set('videoSize', String(video.size));
  if (video?.name) params.set('filename', video.name);
  return params.toString();
}

const shortText = (v, max = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Subtitles of one video from every subtitle addon; what the browser may see.
 * `video` ({ hash, size, name }) lets the addon find files timed for this exact release.
 */
export async function listSubtitles(type, videoId, log, video = null) {
  const extra = videoExtra(video);
  const results = await Promise.allSettled(
    config.subtitleAddons.map(async (base) => {
      const plain = `${base}/subtitles/${type}/${encodeURIComponent(videoId)}`;
      // Some addons don't take extras: then the plain list.
      const body = extra
        ? await getJson(`${plain}/${extra}.json`, 15000).catch(() => getJson(`${plain}.json`, 15000))
        : await getJson(`${plain}.json`, 15000);
      return (body.subtitles || []).map((s) => ({ ...s, addon: new URL(base).hostname }));
    })
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      let host = 'invalid addon URL';
      try {
        host = new URL(config.subtitleAddons[i]).hostname;
      } catch {}
      log?.warn({ addon: host, err: r.reason?.message }, 'subtitle addon failed');
    }
  });
  const all = rankSubtitles(
    results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
    video
  );
  return all.map((s) => {
    const key = randomBytes(12).toString('base64url');
    files.set(key, { url: s.url, expires: Date.now() + LIST_TTL_MS });
    const fps = Number(s.fpsMilli) > 0 ? Number(s.fpsMilli) / 1000 : null;
    return {
      key,
      // Stable across listings (offsets are remembered per file); says nothing of the URL.
      ref: createHash('sha256').update(s.url).digest('base64url').slice(0, 16),
      lang: s.lang.slice(0, 8),
      source: s.addon,
      match: s.match,
      release: shortText(s.movieReleaseName || s.subtitleFileName),
      fps: fps && fps < 121 ? fps : null,
    };
  });
}

export async function cuesFor(key) {
  if (cueCache.has(key)) return cueCache.get(key);
  const file = files.get(key);
  if (!file) return null;
  // The file's address comes from the addon's answer: public addresses only.
  const res = await safeFetch(file.url, { signal: AbortSignal.timeout(20000) }, { allowPrivate: config.allowPrivateSources });
  if (!res.ok) throw new Error(`Sous-titres indisponibles (${res.status})`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_FILE_BYTES) throw new Error('Fichier de sous-titres trop gros');
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Fichier de sous-titres trop gros');
  const cues = parseSubtitles(decodeSubtitle(buffer));
  cueCache.set(key, cues);
  if (cueCache.size > 40) cueCache.delete(cueCache.keys().next().value);
  return cues;
}
