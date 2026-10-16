import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { addonBase, assertConfig, config } from './config.js';
import { issueSession, requireSession, verifySession } from './auth.js';
import { exchangeCode, fetchUser } from './discord.js';
import { openStore } from './db.js';
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  STATE_TTL_S,
  WEB_SESSION_TTL_S,
  authorizeUrl,
  checkState,
  cookieSecure,
  createState,
  issueWebSession,
  normalizeRoomCode,
  parseCookies,
  personalRoomCode,
  redirectUri,
  serializeCookie,
  verifyWebSession,
} from './webauth.js';
import * as addons from './addons.js';
import { cuesFor, listSubtitles } from './subtitles.js';
import {
  watchStremioServer,
  hlsParams,
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
import { privacyPage, termsPage } from './legal.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  // Per-request lines are noisy with HLS segments: off unless LOG_REQUESTS=1.
  logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
  trustProxy: true,
});
assertConfig(app.log);

await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

const store = openStore(config.dataDir);
app.log.info({ dataDir: config.dataDir }, 'database ready');

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

const discordConfigured = () => !!(config.discord.clientId && config.discord.clientSecret);

app.get('/api/config', async (request) => ({
  clientId: config.discord.clientId || null,
  browserMode: config.allowBrowserMode,
  webLogin: discordConfigured(),
  // Public address of this site (links opened outside the Discord iframe).
  publicUrl: config.publicUrl || `${request.protocol}://${request.host}`,
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
  store.upsertUser(user);
  // One room per Activity instance: everybody who joined the same activity.
  const session = issueSession({ ...user, room: `discord:${instanceId.slice(0, 128)}` });
  return { access_token: accessToken, session, user, room: null };
});

app.post('/api/dev-session', async (request, reply) => {
  if (!config.allowBrowserMode) return reply.code(404).send({ error: 'Not found' });
  const { name, room } = request.body || {};
  const cleanName = String(name || '').trim().slice(0, 32) || 'Invité';
  const cleanRoom = String(room || 'test').replace(/[^\w-]/g, '').slice(0, 64) || 'test';
  // Local test mode only: the account is keyed by the name, flagged as a guest.
  const slug = cleanName.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').slice(0, 32) || 'invite';
  const user = { uid: `guest:${slug}`, name: cleanName, avatar: null, guest: true };
  store.upsertUser(user);
  return {
    session: issueSession({ ...user, room: `dev:${cleanRoom}` }),
    user,
    room: { code: cleanRoom, personal: false },
  };
});

// ---------------------------------------------------------------- web login (outside Discord)

app.get('/api/auth/discord/login', async (request, reply) => {
  if (!discordConfigured()) return reply.code(503).send({ error: 'Connexion Discord non configurée sur le serveur' });
  const { state, cookie } = createState();
  const secure = cookieSecure(request);
  // Where to land after login (only a room code is kept: no open redirect).
  const join = normalizeRoomCode(request.query.room);
  reply.header('Set-Cookie', serializeCookie(STATE_COOKIE, join ? `${cookie}|${join}` : cookie, { maxAge: STATE_TTL_S, secure, path: '/api/auth' }));
  return reply.redirect(authorizeUrl({ clientId: config.discord.clientId, redirect: redirectUri(request), state }));
});

app.get('/api/auth/discord/callback', async (request, reply) => {
  const cookies = parseCookies(request.headers.cookie);
  const [stateCookie, join] = String(cookies[STATE_COOKIE] || '').split('|');
  const secure = cookieSecure(request);
  const clearState = serializeCookie(STATE_COOKIE, '', { maxAge: 0, secure, path: '/api/auth' });
  const { code, state, error } = request.query;
  if (error || typeof code !== 'string' || !checkState(stateCookie, state)) {
    request.log.warn({ error: error || 'bad state' }, 'web login refused');
    reply.header('Set-Cookie', clearState);
    return reply.redirect('/?login=failed');
  }
  const accessToken = await exchangeCode(code, redirectUri(request));
  const user = await fetchUser(accessToken);
  store.upsertUser(user);
  reply.header('Set-Cookie', [
    clearState,
    serializeCookie(SESSION_COOKIE, issueWebSession(user), { maxAge: WEB_SESSION_TTL_S, secure }),
  ]);
  return reply.redirect(join && normalizeRoomCode(join) ? `/?room=${join}` : '/');
});

app.post('/api/auth/logout', async (request, reply) => {
  reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: cookieSecure(request) }));
  return { ok: true };
});

/** Web cookie → bearer session for the API/socket, in the personal room or a joined one. */
app.post('/api/session', async (request, reply) => {
  const web = verifyWebSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  const account = web && store.getUser(web.uid);
  if (!account) return reply.code(401).send({ error: 'Non connecté' });
  const own = personalRoomCode(account.uid);
  const asked = request.body?.room;
  if (asked && !normalizeRoomCode(asked)) return reply.code(400).send({ error: 'Code de salle invalide' });
  const code = normalizeRoomCode(asked) || own;
  const user = { uid: account.uid, name: account.name, avatar: account.avatar };
  return {
    session: issueSession({ ...user, room: `web:${code}` }),
    user,
    room: { code, personal: code === own },
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

  api.get('/api/catalogs', async () => ({ catalogs: await addons.catalogs() }));

  api.get('/api/catalog/:type/:id', async (request, reply) => {
    const { type, id } = request.params;
    if (!['movie', 'series'].includes(type)) return reply.code(400).send({ error: 'Type invalide' });
    const { genre, skip } = request.query;
    return addons.catalog(type, id, { genre: typeof genre === 'string' ? genre : null, skip });
  });

  api.get('/api/meta/:type/:id', async (request, reply) => {
    const { type, id } = request.params;
    if (!['movie', 'series'].includes(type)) return reply.code(400).send({ error: 'Type invalide' });
    return { meta: await addons.meta(type, id) };
  });

  api.get('/api/streams/:type/:id', async (request, reply) => {
    const { type, id } = request.params;
    if (!['movie', 'series'].includes(type)) return reply.code(400).send({ error: 'Type invalide' });
    const own = store.addonUrls(request.session.uid).map(addonBase);
    return addons.streams(type, id, request.log, own);
  });

  /** Starts a stream for the whole room. */
  api.post('/api/room/play', async (request, reply) => {
    const { streamKey, title, subtitle, poster, startAt, meta } = request.body || {};
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
    // What everyone's progress is saved against (see the "progress" socket message).
    session.meta = cleanMeta(meta, { title, subtitle, poster });
    const room = rooms.get(roomId);
    room.load(
      {
        ...publicMedia(session),
        title: String(title || '').slice(0, 200),
        subtitle: String(subtitle || '').slice(0, 200),
        poster: typeof poster === 'string' ? poster : null,
        startedBy: request.session.name,
        meta: session.meta,
      },
      { startAt: Number(startAt) || 0 }
    );
    broadcast(room);
    return { ok: true };
  });

  /** External subtitles of what a media session plays (each viewer picks their own). */
  const subtitleLists = new Map();
  api.get('/api/subtitles/:sid', async (request, reply) => {
    const media = getSession(request.params.sid);
    if (!media) return reply.code(404).send({ error: 'Session inconnue' });
    const meta = media.meta;
    if (!meta?.videoId || !config.subtitleAddons.length) return { items: [] };
    const cacheKey = `${meta.type}:${meta.videoId}`;
    let entry = subtitleLists.get(cacheKey);
    if (!entry || entry.expires < Date.now()) {
      // One query per video for the whole room, shared for 30 min.
      entry = { items: listSubtitles(meta.type, meta.videoId, request.log), expires: Date.now() + 30 * 60 * 1000 };
      subtitleLists.set(cacheKey, entry);
      entry.items.catch(() => subtitleLists.delete(cacheKey));
      if (subtitleLists.size > 200) subtitleLists.delete(subtitleLists.keys().next().value);
    }
    return { items: await entry.items };
  });

  api.get('/api/subtitles/cues/:key', async (request, reply) => {
    let cues;
    try {
      cues = await cuesFor(request.params.key);
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
    if (!cues) return reply.code(404).send({ error: 'Sous-titres expirés' });
    reply.header('Cache-Control', 'private, max-age=3600');
    return { cues };
  });

  api.post('/api/room/stop', async (request) => {
    const room = rooms.peek(request.session.room);
    if (room?.stop()) broadcast(room);
    return { ok: true };
  });

  // ------------------------------------------------------------ per-user data
  // Always the session's own account: request.session.uid, never a parameter.

  api.get('/api/me', async (request) => ({
    user: store.getUser(request.session.uid),
    room: request.session.room,
  }));

  api.get('/api/continue', async (request) => ({ items: store.continueWatching(request.session.uid) }));

  /** Hides a title from "Continuer à regarder" (it stays in the history). */
  api.delete('/api/continue/:metaId', async (request) => ({
    ok: store.dismissContinue(request.session.uid, request.params.metaId),
  }));

  /** "Marquer comme vu / non vu" for a movie, an episode or a whole season. */
  api.post('/api/watched', async (request, reply) => {
    const { metaId, type, name, poster, videos, watched } = request.body || {};
    if (typeof metaId !== 'string' || !metaId || !['movie', 'series'].includes(type) || !Array.isArray(videos) || !videos.length) {
      return reply.code(400).send({ error: 'Requête invalide' });
    }
    if (videos.length > 2000) return reply.code(400).send({ error: 'Trop de vidéos' });
    const uid = request.session.uid;
    const count = watched
      ? store.markWatched(uid, { metaId, metaType: type, name, poster, videos })
      : store.markUnwatched(uid, metaId, videos.map((v) => v?.videoId));
    return { count, items: store.progressFor(uid, metaId) };
  });

  api.get('/api/history', async (request) => ({ items: store.history(request.session.uid) }));

  api.delete('/api/history', async (request) => ({ count: store.clearHistory(request.session.uid) }));

  api.delete('/api/history/:metaId', async (request) => ({
    ok: store.removeHistory(request.session.uid, request.params.metaId),
  }));

  api.get('/api/progress/:metaId', async (request) => ({
    items: store.progressFor(request.session.uid, request.params.metaId),
    inLibrary: store.inLibrary(request.session.uid, request.params.metaId),
  }));

  api.get('/api/library', async (request) => {
    const { type, sort } = request.query;
    return { items: store.library(request.session.uid, { type, sort }) };
  });

  api.put('/api/library/:type/:metaId', async (request, reply) => {
    const { type, metaId } = request.params;
    if (!['movie', 'series'].includes(type)) return reply.code(400).send({ error: 'Type invalide' });
    const { name, poster, year, rating } = request.body || {};
    store.addToLibrary(request.session.uid, { metaId, metaType: type, name, poster, year, rating });
    return { ok: true };
  });

  api.delete('/api/library/:type/:metaId', async (request) => ({
    ok: store.removeFromLibrary(request.session.uid, request.params.metaId),
  }));

  /** Everything stored about me, as a JSON file (addon URLs stay masked). */
  api.get('/api/me/export', async (request, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="watch-party-mes-donnees.json"');
    reply.header('Cache-Control', 'no-store');
    return store.exportData(request.session.uid);
  });

  /** Erases my history, library and personal addons (the account stays: it is the login). */
  api.delete('/api/me/data', async (request) => ({ count: store.eraseData(request.session.uid) }));

  api.get('/api/addons', async (request) => ({
    shared: config.streamAddons.length,
    items: store.listAddons(request.session.uid),
  }));

  api.post('/api/addons', async (request, reply) => {
    if (store.listAddons(request.session.uid).length >= 10) {
      return reply.code(400).send({ error: 'Maximum 10 addons' });
    }
    const { base, name } = await addons.inspectStreamAddon(String(request.body?.url || ''), {
      allowHttp: config.allowBrowserMode,
    });
    store.addAddon(request.session.uid, `${base}/manifest.json`, name);
    return { items: store.listAddons(request.session.uid) };
  });

  api.delete('/api/addons/:id', async (request) => ({
    ok: store.removeAddon(request.session.uid, request.params.id),
  }));
});

function cleanMeta(meta, { title, subtitle, poster }) {
  if (!meta || typeof meta !== 'object') return null;
  const s = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const id = s(meta.id, 200);
  const videoId = s(meta.videoId, 200) || id;
  if (!id || !['movie', 'series'].includes(meta.type)) return null;
  return {
    id,
    type: meta.type,
    videoId,
    name: s(title, 200) || id,
    episode: s(subtitle, 200),
    poster: s(poster, 500),
  };
}

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
      case 'progress': {
        // This viewer's own position in a media session they were handed.
        const media = typeof msg.sid === 'string' ? getSession(msg.sid) : null;
        if (!media?.meta) return;
        const m = media.meta;
        store.saveProgress(session.uid, {
          videoId: m.videoId,
          metaId: m.id,
          metaType: m.type,
          name: m.name,
          poster: m.poster,
          episode: m.episode,
          position: msg.position,
          duration: media.info.duration,
        });
        return;
      }
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
  const params = parsed && hlsParams(sid, session.info, parsed.quality, parsed.caps, rest);
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

// Terms of Service / Privacy Policy (URLs to give Discord in the Developer Portal).
for (const [paths, render] of [
  [['/conditions', '/terms'], termsPage],
  [['/confidentialite', '/privacy'], privacyPage],
]) {
  for (const path of paths) {
    app.get(path, async (request, reply) => reply.type('text/html; charset=utf-8').send(render()));
  }
}

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
