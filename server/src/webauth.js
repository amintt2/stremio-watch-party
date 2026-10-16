// Discord OAuth2 login for the website (outside the Activity): authorization code
// flow, `state` bound to an httpOnly cookie, then a signed httpOnly session cookie.
// The cookie only identifies the account; the app still talks to the API with the
// short-lived bearer session from auth.js, issued by POST /api/session.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const STATE_COOKIE = 'wp_oauth_state';
export const SESSION_COOKIE = 'wp_session';
export const STATE_TTL_S = 10 * 60;
export const WEB_SESSION_TTL_S = 30 * 24 * 60 * 60;

function mac(purpose, payload) {
  return createHmac('sha256', config.sessionSecret).update(`${purpose}.${payload}`).digest('base64url');
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- cookies

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed value: ignore that cookie */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure = true, path = '/', sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Secure everywhere except plain-http localhost (local testing). */
export function cookieSecure(request) {
  return request.protocol === 'https' || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(request.host || '');
}

// ---------------------------------------------------------------- OAuth state (CSRF)

/** Random state for the authorize URL + the signed cookie value that must come back with it. */
export function createState(now = Date.now()) {
  const state = randomBytes(18).toString('base64url');
  const payload = `${state}.${Math.floor(now / 1000) + STATE_TTL_S}`;
  return { state, cookie: `${payload}.${mac('state', payload)}` };
}

export function checkState(cookieValue, returned, now = Date.now()) {
  if (typeof cookieValue !== 'string' || typeof returned !== 'string' || !returned) return false;
  const [state, exp, sig] = cookieValue.split('.');
  if (!state || !exp || !sig) return false;
  if (!equal(sig, mac('state', `${state}.${exp}`))) return false;
  if (Number(exp) * 1000 < now) return false;
  return equal(state, returned);
}

// ---------------------------------------------------------------- web session cookie

export function issueWebSession(user, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ uid: user.uid, name: user.name, avatar: user.avatar, exp: now + WEB_SESSION_TTL_S * 1000 })
  ).toString('base64url');
  return `${payload}.${mac('web', payload)}`;
}

export function verifyWebSession(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig || !equal(sig, mac('web', payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < now || typeof data.uid !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Discord URLs

export function redirectUri(request) {
  const base = config.publicUrl || `${request.protocol}://${request.host}`;
  return `${base}/api/auth/discord/callback`;
}

export function authorizeUrl({ clientId, redirect, state }) {
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'identify', state, prompt: 'none' });
  return `https://discord.com/oauth2/authorize?${q}`;
}

// ---------------------------------------------------------------- rooms outside Discord

const ROOM_CODE_RE = /^[a-z0-9]{6,16}$/;

/** Each account's personal room, stable and unguessable: share it to watch together. */
export function personalRoomCode(uid) {
  return createHmac('sha256', config.sessionSecret)
    .update(`room.${uid}`)
    .digest('hex')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);
}

export function normalizeRoomCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return ROOM_CODE_RE.test(c) ? c : null;
}
