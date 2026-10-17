// External players (VLC, Infuse, MX Player...) and "Ouvrir sur le site".
//
// - A private file URL per media session and viewer: /api/media/<sid>/file/<token>/<name>.
//   External players have no cookie and no bearer, so the token in the path is the
//   credential: HMAC over sid + uid + expiry, valid EXTERNAL_TTL_S. The original file is
//   proxied as is (Range passthrough, every audio track and embedded subtitle, no
//   transcoding); its upstream URL (debrid link, engine address) never leaves the server.
// - Handoff codes: a viewer inside the Discord Activity gets a one-time code that the
//   website exchanges for a web session in the same room, without logging in again.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const EXTERNAL_TTL_S = 12 * 60 * 60;
export const HANDOFF_TTL_MS = 5 * 60 * 1000;
/** A room pass keeps a handed-off tab in its room across reloads. */
export const ROOM_PASS_TTL_S = 12 * 60 * 60;
const HANDOFF_MAX = 2000;

function mac(purpose, payload) {
  return createHmac('sha256', config.sessionSecret).update(`${purpose}.${payload}`).digest('base64url');
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- file tokens

/** "<uid base64url>.<expiry s>.<mac>": URL-safe, fits in a path segment. */
export function signFileToken(sid, uid, now = Date.now()) {
  const exp = Math.floor(now / 1000) + EXTERNAL_TTL_S;
  const who = Buffer.from(String(uid)).toString('base64url');
  return `${who}.${exp}.${mac('file', `${sid}.${who}.${exp}`)}`;
}

/** The uid the token was issued to, or null (forged, other session, expired). */
export function verifyFileToken(sid, token, now = Date.now()) {
  if (typeof token !== 'string' || typeof sid !== 'string') return null;
  const [who, exp, sig] = token.split('.');
  if (!who || !/^\d{1,12}$/.test(exp || '') || !sig) return null;
  if (!equal(sig, mac('file', `${sid}.${who}.${exp}`))) return null;
  if (Number(exp) * 1000 < now) return null;
  return Buffer.from(who, 'base64url').toString('utf8') || null;
}

/** Cosmetic last path segment (players show it as the title): safe characters only. */
export function safeFileName(name) {
  const clean = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.()[\] -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s_-]+/, '')
    .trim()
    .slice(-150);
  if (!clean) return 'video.mkv';
  return /\.[a-z0-9]{2,4}$/i.test(clean) ? clean : `${clean}.mkv`;
}

const TYPES = { mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', mov: 'video/quicktime' };

export function guessType(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

export function fileUrl(base, sid, token, name) {
  return `${base}/api/media/${encodeURIComponent(sid)}/file/${token}/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------- range proxy

const RANGE_RE = /^bytes=\d*-\d*(,\s*\d*-\d*)*$/;
// Upstream headers worth passing on. Nothing that could name the upstream host.
const PASS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/**
 * Streams `mediaURL` to the reply, with the client's Range (VLC seeks with it). HEAD is
 * forwarded as HEAD, or as a GET whose body is dropped when the upstream refuses HEAD.
 * The upstream request is aborted as soon as the player hangs up.
 */
export async function proxyFile(request, reply, mediaURL, { name }) {
  const head = request.method === 'HEAD';
  const range = request.headers.range;
  const headers = {};
  if (typeof range === 'string' && RANGE_RE.test(range)) headers.Range = range;

  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  const call = (method) => fetch(mediaURL, { method, headers, signal: abort.signal });

  let upstream;
  try {
    upstream = await call(head ? 'HEAD' : 'GET');
    if (head && [400, 403, 405, 501].includes(upstream.status)) {
      upstream = await call('GET');
      upstream.body?.cancel().catch(() => {});
    }
  } catch (err) {
    if (abort.signal.aborted) return reply;
    request.log.warn({ err: err.message }, 'external file upstream unreachable');
    return reply.code(502).send({ error: 'Source injoignable' });
  }

  if (upstream.status === 416) {
    upstream.body?.cancel().catch(() => {});
    const total = upstream.headers.get('content-range');
    if (total) reply.header('Content-Range', total);
    return reply.code(416).send();
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    upstream.body?.cancel().catch(() => {});
    request.log.warn({ status: upstream.status }, 'external file upstream error');
    return reply.code(502).send({ error: 'La source a refusé la lecture' });
  }

  reply.code(upstream.status);
  for (const h of PASS) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) reply.header('Accept-Ranges', upstream.status === 206 ? 'bytes' : 'none');
  const type = upstream.headers.get('content-type') || '';
  // Engines often answer octet-stream: the name's extension tells players more.
  reply.type(/^(video|audio)\//.test(type) ? type : guessType(name));
  reply.header('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Referrer-Policy', 'no-referrer');
  if (head) {
    upstream.body?.cancel().catch(() => {});
    return reply.send();
  }
  return reply.send(upstream.body);
}

// ---------------------------------------------------------------- handoff (Activity → site)

/** Single-use codes in memory: code -> { user, room, expires }. */
export class Handoffs {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.codes = new Map();
  }

  create(user, room) {
    this.sweep();
    while (this.codes.size >= HANDOFF_MAX) this.codes.delete(this.codes.keys().next().value);
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      user: { uid: user.uid, name: user.name, avatar: user.avatar ?? null },
      room,
      expires: this.now() + HANDOFF_TTL_MS,
    });
    return code;
  }

  /** The entry once, then never again (also gone when expired). */
  consume(code) {
    if (typeof code !== 'string' || !code) return null;
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return entry.expires > this.now() ? entry : null;
  }

  sweep() {
    const t = this.now();
    for (const [code, e] of this.codes) if (e.expires <= t) this.codes.delete(code);
  }
}

/** Signed { uid, room } so a handed-off tab gets its room back after a reload. */
export function issueRoomPass({ uid, room }, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ uid, room, exp: now + ROOM_PASS_TTL_S * 1000 })).toString('base64url');
  return `${payload}.${mac('pass', payload)}`;
}

/** The room the pass grants, only for the uid it was issued to. */
export function verifyRoomPass(value, uid, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig || !equal(sig, mac('pass', payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < now || data.uid !== uid || typeof data.room !== 'string') return null;
    return data.room;
  } catch {
    return null;
  }
}
