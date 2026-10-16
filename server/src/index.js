import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { assertConfig, config } from './config.js';
import { issueSession, requireSession, verifySession } from './auth.js';
import { exchangeCode, fetchUser } from './discord.js';
import * as addons from './addons.js';
import {
  watchStremioServer,
  converterParams,
  createSession,
  fetchHls,
  getSession,
  isAllowedHlsPath,
  parseProfile,
  publicMedia,
  rewritePlaylist,
} from './media.js';
import { Rooms } from './rooms.js';
import { diagnostics, logDiagnostics } from './diag.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  // Per-request lines are noisy with HLS segments: off unless LOG_REQUESTS=1.
  logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
  trustProxy: true,
});
assertConfig(app.log);

await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

const rooms = new Rooms();
/** room id -> Set of sockets */
const sockets = new Map();

function broadcast(room, extra) {
  const message = JSON.stringify({ t: 'state', ...room.snapshot() });
  for (const ws of sockets.get(room.id) || []) {
    if (ws.readyState === 1) {
      ws.send(message);
      if (extra) ws.send(JSON.stringify(extra));
    }
  }
}

function notice(roomId, text) {
  const message = JSON.stringify({ t: 'notice', text });
  for (const ws of sockets.get(roomId) || []) if (ws.readyState === 1) ws.send(message);
}

setInterval(() => {
  for (const room of rooms) if (room.tick()) broadcast(room);
}, 1000).unref();

// ---------------------------------------------------------------- session / auth

app.get('/api/config', async () => ({
  clientId: config.discord.clientId || null,
  browserMode: config.allowBrowserMode,
}));

app.post('/api/token', async (request, reply) => {
  const { code, instanceId } = request.body || {};
  if (typeof code !== 'string' || typeof instanceId !== 'string' || !instanceId) {
    return reply.code(400).send({ error: 'code et instanceId requis' });
  }
  if (!config.discord.clientId || !config.discord.clientSecret) {
    return reply.code(503).send({ error: 'Connexion Discord non configurée sur le serveur' });
  }
  const accessToken = await exchangeCode(code);
  const user = await fetchUser(accessToken);
  // One room per Activity instance: everybody who joined the same activity.
  const session = issueSession({ ...user, room: `discord:${instanceId.slice(0, 128)}` });
  return { access_token: accessToken, session, user };
});

app.post('/api/dev-session', async (request, reply) => {
  if (!config.allowBrowserMode) return reply.code(404).send({ error: 'Not found' });
  const { name, room } = request.body || {};
  const cleanName = String(name || '').trim().slice(0, 32) || 'Invité';
  const cleanRoom = String(room || 'test').replace(/[^\w-]/g, '').slice(0, 64) || 'test';
  const uid = `guest-${Math.random().toString(36).slice(2, 10)}`;
  return {
    session: issueSession({ uid, name: cleanName, avatar: null, room: `dev:${cleanRoom}` }),
    user: { uid, name: cleanName, avatar: null },
  };
});

// ---------------------------------------------------------------- catalog

app.register(async (api) => {
  api.addHook('preHandler', requireSession);

  api.get('/api/search', async (request, reply) => {
    const q = String(request.query.q || '').trim();
    if (q.length < 2) return reply.code(400).send({ error: 'Recherche trop courte' });
    return { results: await addons.search(q.slice(0, 100)) };
  });

  api.get('/api/meta/:type/:id', async (request, reply) => {
    const { type, id } = request.params;
    if (!['movie', 'series'].includes(type)) return reply.code(400).send({ error: 'Type invalide' });
    return { meta: await addons.meta(type, id) };
  });

  api.get('/api/streams/:type/:id', async (request, reply) => {
    const { type, id } = request.params;
    if (!['movie', 'series'].includes(type)) return reply.code(400).send({ error: 'Type invalide' });
    return addons.streams(type, id, request.log);
  });

  /** Starts a stream for the whole room. */
  api.post('/api/room/play', async (request, reply) => {
    const { streamKey, title, subtitle, poster } = request.body || {};
    const stream = addons.lookupStream(streamKey);
    if (!stream) return reply.code(410).send({ error: 'Source expirée, relance la recherche' });

    const roomId = request.session.room;
    notice(roomId, `${request.session.name} lance « ${String(title || '').slice(0, 120)} »…`);
    let session;
    try {
      session = await createSession(stream);
    } catch (err) {
      request.log.warn({ err: err.message }, 'stream resolution failed');
      notice(roomId, `Impossible de lancer : ${err.message}`);
      return reply.code(502).send({ error: err.message });
    }
    const room = rooms.get(roomId);
    room.load({
      ...publicMedia(session),
      title: String(title || '').slice(0, 200),
      subtitle: String(subtitle || '').slice(0, 200),
      poster: typeof poster === 'string' ? poster : null,
      startedBy: request.session.name,
    });
    broadcast(room);
    return { ok: true };
  });

  api.post('/api/room/stop', async (request) => {
    const room = rooms.peek(request.session.room);
    if (room?.stop()) broadcast(room);
    return { ok: true };
  });
});

// ---------------------------------------------------------------- sync socket

app.get('/api/ws', { websocket: true }, (ws, request) => {
  const session = verifySession(String(request.query.token || ''));
  if (!session) {
    ws.close(4001, 'unauthorized');
    return;
  }
  const room = rooms.get(session.room);
  if (!sockets.has(room.id)) sockets.set(room.id, new Set());
  sockets.get(room.id).add(ws);

  if (room.join(session)) broadcast(room);
  else ws.send(JSON.stringify({ t: 'state', ...room.snapshot() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    let changed = false;
    switch (msg.t) {
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
        return;
      case 'play':
        changed = room.play();
        break;
      case 'pause':
        changed = room.pause();
        break;
      case 'seek':
        changed = room.seek(msg.position);
        break;
      case 'buffering':
        changed = room.setBuffering(session.uid, !!msg.value);
        break;
      case 'quality':
        changed = room.setQuality(session.uid, msg.value);
        break;
      default:
        return;
    }
    if (changed) broadcast(room);
  });

  ws.on('close', () => {
    sockets.get(room.id)?.delete(ws);
    if (room.leave(session.uid)) broadcast(room);
    if (room.empty) {
      sockets.delete(room.id);
      rooms.delete(room.id);
    }
  });
});

// ---------------------------------------------------------------- HLS relay

// The session id in the path is an unguessable capability handed to room members.
// The profile segment is "<quality><capability letters>" (see parseProfile); it lives
// in the path so the relative URIs inside playlists keep it.
app.get('/api/hls/:sid/:profile/*', async (request, reply) => {
  const { sid, profile } = request.params;
  const rest = request.params['*'];
  const session = getSession(sid);
  if (!session) return reply.code(404).send({ error: 'Session inconnue' });
  if (!isAllowedHlsPath(rest)) return reply.code(400).send({ error: 'Chemin invalide' });

  const parsed = parseProfile(profile);
  const params = parsed && converterParams(sid, session.info, parsed.quality, parsed.caps);
  if (!params) return reply.code(400).send({ error: 'Qualité invalide' });

  const abort = new AbortController();
  request.raw.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetchHls(session, params, rest, abort.signal);
  } catch (err) {
    if (abort.signal.aborted) return reply;
    return reply.code(502).send({ error: `Serveur Stremio injoignable : ${err.message}` });
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    // Viewers share a converter: a seek cancels in-flight segments, hls.js retries them.
    const level = body.includes('canceled') ? 'debug' : 'warn';
    request.log[level]({ status: upstream.status, rest, body: body.slice(0, 300) }, 'hls upstream error');
    return reply.code(502).send({ error: 'Erreur du convertisseur', status: upstream.status });
  }

  reply.header('Cache-Control', 'no-store');
  if (rest.endsWith('.m3u8')) {
    reply.type('application/vnd.apple.mpegurl');
    return rewritePlaylist(await upstream.text());
  }
  reply.type(upstream.headers.get('content-type') || 'application/octet-stream');
  const length = upstream.headers.get('content-length');
  if (length) reply.header('Content-Length', length);
  return reply.send(upstream.body);
});

// ---------------------------------------------------------------- image proxy

// The Activity iframe can only load from its own origin, so posters/avatars go through here.
app.get('/api/img', async (request, reply) => {
  let url;
  try {
    url = new URL(String(request.query.u || ''));
  } catch {
    return reply.code(400).send();
  }
  const allowed = (u) => u.protocol === 'https:' && config.imageHosts.includes(u.hostname);
  if (!allowed(url)) return reply.code(403).send();

  // Follow redirects by hand so they can't lead outside the allowlist.
  let upstream = null;
  for (let hop = 0; hop < 4; hop++) {
    upstream = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
    const location = upstream?.status >= 300 && upstream.status < 400 && upstream.headers.get('location');
    if (!location) break;
    url = new URL(location, url);
    if (!allowed(url)) return reply.code(403).send();
    upstream = null;
  }
  const type = upstream?.headers.get('content-type') || '';
  if (!upstream?.ok || !type.startsWith('image/')) return reply.code(502).send();
  const length = Number(upstream.headers.get('content-length') || 0);
  if (length > 10 * 1024 * 1024) return reply.code(413).send();
  reply.type(type).header('Cache-Control', 'public, max-age=86400');
  return reply.send(Buffer.from(await upstream.arrayBuffer()));
});

app.get('/api/health', async () => ({ ok: true }));

// Sanitized dependency check (Stremio server, meta and stream addons), cached 30 s.
app.get('/api/health/details', async () => diagnostics());

// ---------------------------------------------------------------- static client

const dist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (existsSync(dist)) {
  await app.register(fastifyStatic, {
    root: dist,
    setHeaders(reply, path) {
      // Hashed assets can be cached forever; index.html must always be fresh.
      reply.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn('client/dist not found: run "npm run build" (or use the Vite dev server)');
}

app.setErrorHandler((err, request, reply) => {
  request.log.error({ err }, 'request failed');
  reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({
    error: err.statusCode && err.statusCode < 500 ? err.message : 'Erreur serveur',
  });
});

watchStremioServer(app.log);
// Give the Stremio container a moment to start, then log what is reachable.
setTimeout(() => logDiagnostics(app.log).catch((err) => app.log.warn({ err: err.message }, 'diag failed')), 15_000).unref();
await app.listen({ port: config.port, host: config.host });
