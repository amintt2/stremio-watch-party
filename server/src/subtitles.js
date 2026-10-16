// External subtitles from Stremio subtitle addons (OpenSubtitles v3 by default).
// The browser gets an opaque key per subtitle and asks for its cues by key: addon
// and file URLs stay on the server. Each viewer picks their own language.

import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PER_LANG = 6;
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
    .replace(/<[^>]*>/g, '')
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

/** French first, then English, then the rest by name; a few per language. */
export function rankSubtitles(list, preferred = ['fre', 'fra', 'fr', 'eng', 'en']) {
  const rank = (lang) => {
    const i = preferred.indexOf(lang);
    return i < 0 ? preferred.length : i;
  };
  const perLang = new Map();
  return list
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && typeof s.lang === 'string')
    .sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang))
    .filter((s) => {
      const n = (perLang.get(s.lang) || 0) + 1;
      perLang.set(s.lang, n);
      return n <= MAX_PER_LANG;
    });
}

/** Subtitles of one video from every subtitle addon; what the browser may see. */
export async function listSubtitles(type, videoId, log) {
  const results = await Promise.allSettled(
    config.subtitleAddons.map(async (base) => {
      const body = await getJson(`${base}/subtitles/${type}/${encodeURIComponent(videoId)}.json`, 15000);
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
  const all = rankSubtitles(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  return all.map((s) => {
    const key = randomBytes(12).toString('base64url');
    files.set(key, { url: s.url, expires: Date.now() + LIST_TTL_MS });
    return { key, lang: s.lang.slice(0, 8), source: s.addon };
  });
}

export async function cuesFor(key) {
  if (cueCache.has(key)) return cueCache.get(key);
  const file = files.get(key);
  if (!file) return null;
  const res = await fetch(file.url, { signal: AbortSignal.timeout(20000) });
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
