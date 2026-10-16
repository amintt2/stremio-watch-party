import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const TTL_MS = 24 * 60 * 60 * 1000;

function sign(payload) {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

/** Session token = base64url(JSON payload) + "." + HMAC. Holds the user and their room. */
export function issueSession({ uid, name, avatar, room }) {
  const payload = Buffer.from(
    JSON.stringify({ uid, name, avatar, room, exp: Date.now() + TTL_MS })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token) {
  if (typeof token !== 'string') return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Fastify preHandler: requires "Authorization: Bearer <session>". */
export async function requireSession(request, reply) {
  const header = request.headers.authorization || '';
  const session = verifySession(header.replace(/^Bearer\s+/i, ''));
  if (!session) {
    return reply.code(401).send({ error: 'Session invalide ou expirée' });
  }
  request.session = session;
}
