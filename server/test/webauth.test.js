import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  STATE_TTL_S,
  authorizeUrl,
  checkState,
  cookieSecure,
  createState,
  issueWebSession,
  normalizeRoomCode,
  parseCookies,
  personalRoomCode,
  serializeCookie,
  verifyWebSession,
} from '../src/webauth.js';

config.sessionSecret = 'test-secret';

test('cookies parse and serialize with httpOnly/Secure/SameSite', () => {
  assert.deepEqual(parseCookies('a=1; b=x%20y;c=;bad; a=2'), { a: '1', b: 'x y', c: '' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=%E0%A4%A'), {}, 'malformed value ignored');

  const c = serializeCookie('wp', 'v;1', { maxAge: 60 });
  assert.match(c, /^wp=v%3B1; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60; Secure$/);
  assert.ok(!serializeCookie('wp', 'v', { secure: false }).includes('Secure'));
  assert.match(serializeCookie('wp', '', { maxAge: 0, path: '/api/auth' }), /Path=\/api\/auth.*Max-Age=0/);
});

test('cookies are Secure except on plain-http localhost', () => {
  assert.equal(cookieSecure({ protocol: 'https', host: 'watch.example.com' }), true);
  assert.equal(cookieSecure({ protocol: 'http', host: 'watch.example.com' }), true);
  assert.equal(cookieSecure({ protocol: 'http', host: 'localhost:3001' }), false);
  assert.equal(cookieSecure({ protocol: 'http', host: '127.0.0.1:3001' }), false);
});

test('OAuth state must match its signed cookie', () => {
  const now = 1_700_000_000_000;
  const { state, cookie } = createState(now);
  assert.equal(checkState(cookie, state, now), true);
  assert.equal(checkState(cookie, `${state}x`, now), false, 'different state');
  assert.equal(checkState(cookie, '', now), false);
  assert.equal(checkState(undefined, state, now), false, 'no cookie (other browser)');
  assert.equal(checkState(cookie, state, now + (STATE_TTL_S + 1) * 1000), false, 'expired');

  const other = createState(now);
  assert.equal(checkState(other.cookie, state, now), false, "someone else's cookie");

  // A forged cookie for an attacker-chosen state fails the signature.
  const [, exp] = cookie.split('.');
  assert.equal(checkState(`evil.${exp}.${cookie.split('.')[2]}`, 'evil', now), false);
});

test('web session cookie: signed, expiring, tamper-proof', () => {
  const now = 1_700_000_000_000;
  const value = issueWebSession({ uid: '123', name: 'Alice', avatar: null }, now);
  assert.equal(verifyWebSession(value, now).uid, '123');
  assert.equal(verifyWebSession(value, now + 31 * 86400_000), null, 'expired');

  const [payload, sig] = value.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: '999', name: 'X', exp: now + 1e9 })).toString('base64url');
  assert.equal(verifyWebSession(`${forged}.${sig}`, now), null);
  assert.equal(verifyWebSession(`${payload}.`, now), null);
  assert.equal(verifyWebSession(undefined, now), null);

  config.sessionSecret = 'rotated';
  assert.equal(verifyWebSession(value, now), null, 'secret rotation logs everybody out');
  config.sessionSecret = 'test-secret';
});

test('authorize URL asks only for identify, with the state and redirect URI', () => {
  const url = new URL(authorizeUrl({ clientId: '42', redirect: 'https://w.example/api/auth/discord/callback', state: 'abc' }));
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(url.searchParams.get('state'), 'abc');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://w.example/api/auth/discord/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('room codes: stable personal code, strict format', () => {
  const a = personalRoomCode('123');
  assert.equal(a, personalRoomCode('123'));
  assert.notEqual(a, personalRoomCode('124'));
  assert.equal(normalizeRoomCode(a), a);
  assert.equal(normalizeRoomCode(' ABCdef12 '), 'abcdef12');
  assert.equal(normalizeRoomCode('../etc'), null);
  assert.equal(normalizeRoomCode('abc'), null);
  assert.equal(normalizeRoomCode(undefined), null);
});
