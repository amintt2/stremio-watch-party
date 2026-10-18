import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  ensureFileHash,
  fetchHls,
  getSession,
  fetchTorrentHealth,
  formatGb,
  isAllowedHlsPath,
  parseProfile,
  publicMedia,
  rewritePlaylist,
} from './media.js';
import { Rooms, mediaLabel } from './rooms.js';
import { RateLimiter, cleanProposal, handleRoomMessage } from './roomSocket.js';
import { diagnostics, logDiagnostics } from './diag.js';
import { Handoffs, fileUrl, issueRoomPass, proxyFile, safeFileName, signFileToken, verifyFileToken, verifyRoomPass } from './external.js';
import { privacyPage, termsPage } from './legal.js';
import { registerEncoder } from './encoderRoutes.js';
import { HuwaProbes, chooseSources } from './race.js';
import { parseGpuPath } from './encoder.js';
import { createGateway, routeOf } from './gateway.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  // Per-request lines are noisy with HLS segments: off unless LOG_REQUESTS=1.
  logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
  trustProxy: true,
});
assertConfig(app.log);

// Stremio apps can use this site as their streaming server (Settings → Streaming): its routes
// live at the root, next to the site's (the client only uses #/ routes, the API is /api/).
if (config.stremioGateway) {
  const gateway = createGateway({
    huwaUrl: config.huwaUrl,
    huwaMediaUrl: config.huwaMediaUrl,
    stremioUrl: config.stremioServerUrl,
    stremioSelfUrl: config.stremioSelfUrl,
    engine: config.torrentEngine,
    log: app.log,
  });
  app.addHook('onRequest', (request, reply, done) => {
    if (!routeOf(request.url.split('?')[0])) return done();
    reply.hijack();
    gateway(request.raw, reply.raw);
  });
}

await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

const store = openStore(config.dataDir);
app.log.info({ dataDir: config.dataDir }, 'database ready');

const rooms = new Rooms();
/** room id -> Set of sockets */
const sockets = new Map();

/** What one socket may see: the room state, or only the waiting-room status. */
function stateFor(room, uid, snapshot) {
  if (room.status(uid) === 'pending') {
    const host = room.members.get(room.host)?.name || null;
    return JSON.stringify({ t: 'lobby', host, members: room.members.size });
  }
  return snapshot;
}

function broadcast(room) {
  const snapshot = JSON.stringify({ t: 'state', ...room.snapshot() });
  for (const ws of sockets.get(room.id) || []) {
    if (ws.readyState === 1) ws.send(stateFor(room, ws.uid, snapshot));
  }
}

/** `except`: everyone but that uid (their own action); `to`: only that uid (or uids). */
function notice(roomId, text, { except = null, to = null } = {}) {
  const message = JSON.stringify({ t: 'notice', text });
  const only = to === null ? null : new Set([to].flat());
  const room = rooms.peek(roomId);
  for (const ws of sockets.get(roomId) || []) {
    if (ws.readyState !== 1 || (except && ws.uid === except) || (only && !only.has(ws.uid))) continue;
    // People still in the waiting room only hear what is meant for them.
    if (!only && room?.status(ws.uid) === 'pending') continue;
    ws.send(message);
  }
}

/** Closes every socket of someone who was kicked or refused at the door. */
function expel(roomId, uid, reason) {
  for (const ws of sockets.get(roomId) || []) {
    if (ws.uid !== uid) continue;
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'kicked', reason }));
    ws.close(4003, reason);
  }
}

/** Sends the state, then what the room queued: notices, kicks, stream starts. */
function publish(room) {
  broadcast(room);
  for (const effect of room.drain()) {
    if (effect.type === 'notice') notice(room.id, effect.text, effect);
    else if (effect.type === 'kick') expel(room.id, effect.uid, effect.reason);
    else if (effect.type === 'start') runStart(room, effect);
  }
}

setInterval(() => {
  for (const room of [...rooms]) if (room.tick()) publish(room);
  // Emptied rooms keep their film for a while (someone may come back), then go.
  for (const id of rooms.sweep()) sockets.delete(id);
}, 1000).unref();

// Automatic source choice (race.js): torrents are raced by the Huwa engine's probes.
const probes = config.torrentEngine === 'huwa' ? new HuwaProbes(config.huwaUrl, { file: join(config.dataDir, 'huwa-session.json') }) : null;
/** Episode number of a series video id ("tt0903747:1:5" → 5), for season packs. */
const episodeOf = (videoId) => Number(/:\d+:(\d+)$/.exec(String(videoId || ''))?.[1]) || null;

/** Sources to try, best first: the race winner, then the rest of the ranking. */
async function orderedSources(keys, { want, meta, log }) {
  const t0 = Date.now();
  const res = await chooseSources(keys, { want, probes, episode: episodeOf(meta?.videoId), log });
  log.info({ why: res.why, tested: res.tested, candidates: res.order.length, ms: Date.now() - t0 }, 'source chosen');
  return { streams: res.order.map((x) => x.stream), pick: res.order[0] ? { label: addons.sourceLabel(res.order[0].stream), why: res.why, tested: res.tested } : null };
}

// Host GPU encoders (encoder.js): the app on a member's PC transcodes instead of the server.
const encoders = registerEncoder(app, { store, rooms, publish, getSession, requireSession });

// Coarse flood guard per person on the socket; the room has finer per-action limits.
const floodLimit = new RateLimiter({ max: 40, windowMs: 10_000 });

/**
 * Resolves a stream into a media session and loads it for the room, unless a newer
 * start replaced this one meanwhile. Throws on failure (after telling the room).
 */
async function startMedia(room, { token, stream, streams, pick = null, title, subtitle, poster, meta, startAt = 0, startedBy, starterUid, log }) {
  let session;
  try {
    // Automatic choice: when a source doesn't open, the next one (at most 3 tries).
    const list = (streams || [stream]).slice(0, 3);
    let lastErr = null;
    for (const [i, s] of list.entries()) {
      try {
        session = await createSession(s, log);
        if (i > 0 && pick) pick = { ...pick, label: addons.sourceLabel(s), why: 'fallback' };
        break;
      } catch (err) {
        lastErr = err;
        log.warn({ err: err.message, attempt: i + 1 }, 'source failed to open');
        if (!room.isCurrentStart(token)) return false;
      }
    }
    if (!session) throw lastErr || new Error('Aucune source utilisable');
  } catch (err) {
    log.warn({ err: err.message }, 'stream resolution failed');
    if (room.failStart(token)) publish(room);
    notice(room.id, `Impossible de lancer « ${mediaLabel({ title, subtitle })} » : ${err.message}`);
    throw err;
  }
  if (!room.isCurrentStart(token)) return false;
  // What everyone's progress is saved against (see the "progress" socket message).
  session.meta = cleanMeta(meta, { title, subtitle, poster });
  room.load(
    {
      ...publicMedia(session),
      title: String(title || '').slice(0, 200),
      subtitle: String(subtitle || '').slice(0, 200),
      poster: typeof poster === 'string' ? poster : null,
      startedBy: startedBy || 'la salle',
      startedByUid: starterUid || null,
      meta: session.meta,
      // How the source was chosen (automatic choice): shown in the player.
      pick,
    },
    { startAt: Number(startAt) || 0 }
  );
  publish(room);
  encoders.attach(room, session);
  findNextEpisode(room, session).catch((err) => log.debug({ err: err.message }, 'next episode lookup failed'));
  return true;
}

/** For an episode: tells the room which one comes next (auto-next at the end). */
async function findNextEpisode(room, session) {
  const m = session.meta;
  if (m?.type !== 'series') return;
  const meta = await addons.meta('series', m.id);
  const i = meta.videos.findIndex((v) => v.id === m.videoId);
  const next = i >= 0 ? meta.videos[i + 1] : null;
  if (!next) return;
  const subtitle = `S${next.season}E${String(next.episode).padStart(2, '0')} · ${next.title}`;
  if (room.setNext(session.sid, { videoId: next.id, subtitle })) publish(room);
}

/** A start decided by the room (vote, next episode, "Lancer" on a suggestion). */
async function runStart(room, { token, by, item }) {
  const log = app.log;
  try {
    // The proposer's chosen source if still valid, else the best one with their addons.
    const chosen = item.streamKey ? addons.lookupStream(item.streamKey) : null;
    let streams = chosen ? [chosen] : [];
    let pick = null;
    if (!chosen) {
      // Nobody picked a source: the fastest one, like a start from the film's page.
      const own = item.uid ? store.addonUrls(item.uid).map(addonBase) : [];
      const { streams: list } = await addons.streams(item.meta.type, item.meta.videoId, log, own);
      ({ streams, pick } = await orderedSources(list.map((x) => x.key), { want: null, meta: item.meta, log }));
    }
    if (!room.isCurrentStart(token)) return;
    if (!streams.length) {
      if (room.failStart(token)) publish(room);
      notice(room.id, `Aucune source trouvée pour « ${mediaLabel(item)} »`);
      return;
    }
    const startedBy = (by && room.members.get(by)?.name) || 'la salle';
    await startMedia(room, { token, streams, pick, ...item, startedBy, starterUid: item.uid, log });
  } catch (err) {
    log.warn({ err: err.message }, 'room start failed');
    if (room.failStart(token)) publish(room);
  }
}

// ---------------------------------------------------------------- session / auth

const discordConfigured = () => !!(config.discord.clientId && config.discord.clientSecret);
/** Public address of the site (links opened outside the Discord iframe, external players). */
const siteBase = (request) => config.publicUrl || `${request.protocol}://${request.host}`;

app.get('/api/config', async (request) => ({
  clientId: config.discord.clientId || null,
  browserMode: config.allowBrowserMode,
  webLogin: discordConfigured(),
  // Public address of this site (links opened outside the Discord iframe).
  publicUrl: siteBase(request),
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
  const { name, room, lobby } = request.body || {};
  const cleanName = String(name || '').trim().slice(0, 32) || 'Invité';
  const cleanRoom = String(room || 'test').replace(/[^\w-]/g, '').slice(0, 64) || 'test';
  // Local test mode only: the account is keyed by the name, flagged as a guest.
  const slug = cleanName.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').slice(0, 32) || 'invite';
  const user = { uid: `guest:${slug}`, name: cleanName, avatar: null, guest: true };
  store.upsertUser(user);
  return {
    // lobby: test the website's waiting room locally (?lobby=1).
    session: issueSession({ ...user, room: `${lobby === true ? 'devlobby' : 'dev'}:${cleanRoom}` }),
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
  // A tab handed off from the Activity stays in the Activity's room (see /api/handoff).
  const passRoom = verifyRoomPass(request.body?.pass, account.uid);
  if (passRoom) {
    const user = { uid: account.uid, name: account.name, avatar: account.avatar };
    return { session: issueSession({ ...user, room: passRoom }), user, room: { code: '', personal: false, activity: true } };
  }
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

// ---------------------------------------------------------------- "Ouvrir sur le site"

// One-time codes, in memory: a restart only invalidates codes nobody used within 5 min.
const handoffs = new Handoffs();
const handoffLimit = new RateLimiter({ max: 5, windowMs: 60_000 });

/** Exchanges a handoff code for a web session cookie + a bearer session in the same room. */
app.post('/api/handoff/redeem', async (request, reply) => {
  const entry = handoffs.consume(String(request.body?.code || ''));
  const account = entry && store.getUser(entry.user.uid);
  if (!account) return reply.code(410).send({ error: 'Lien expiré ou déjà utilisé : rouvre-le depuis Discord' });
  const user = { uid: account.uid, name: account.name, avatar: account.avatar };
  reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, issueWebSession(user), { maxAge: WEB_SESSION_TTL_S, secure: cookieSecure(request) }));
  return {
    session: issueSession({ ...user, room: entry.room }),
    pass: issueRoomPass({ uid: user.uid, room: entry.room }),
    user,
    room: { code: '', personal: false, activity: true },
  };
});

// ---------------------------------------------------------------- external players

// The token in the path is the credential (players have no cookie): see external.js.
const fileLimit = new RateLimiter({ max: 240, windowMs: 60_000 });
app.route({
  method: ['GET', 'HEAD'],
  url: '/api/media/:sid/file/:token/:name',
  handler: async (request, reply) => {
    const { sid, token } = request.params;
    const uid = verifyFileToken(sid, token);
    if (!uid) return reply.code(403).send({ error: 'Lien expiré ou invalide' });
    const media = getSession(sid);
    if (!media) return reply.code(404).send({ error: 'Vidéo terminée' });
    // Someone kicked from the room that plays it loses their link too.
    for (const room of rooms) if (room.media?.sid === sid && room.status(uid) === 'blocked') return reply.code(403).send({ error: 'Accès retiré' });
    // VLC seeks with many short range requests: a generous budget, per person.
    if (!fileLimit.allow(uid)) return reply.code(429).send({ error: 'Trop de requêtes' });
    return proxyFile(request, reply, media.mediaURL, { name: safeFileName(media.fileName) });
  },
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
    const { streamKey, candidates, lang, title, subtitle, poster, startAt, meta } = request.body || {};
    // Automatic choice: the client sends every source it got, the server races them.
    const auto = Array.isArray(candidates) && candidates.length > 0;
    const keys = auto ? candidates.filter((k) => typeof k === 'string').slice(0, 80) : [];
    const stream = auto ? null : addons.lookupStream(streamKey);
    if (auto ? !keys.some((k) => addons.lookupStream(k)) : !stream) return reply.code(410).send({ error: 'Source expirée, relance la recherche' });
    if (!auto && addons.describeStream(stream, '').tooBig) {
      return reply.code(413).send({ error: `Trop gros pour le stockage du serveur (max ${formatGb(config.maxTorrentBytes)} Go) : choisis une source plus légère` });
    }

    const { uid, name } = request.session;
    const room = rooms.peek(request.session.room);
    if (!room || room.status(uid) !== 'member') return reply.code(409).send({ error: 'Tu n’es pas dans la salle' });
    const cleanTitle = String(title || '').slice(0, 200);
    const label = mediaLabel({ title: cleanTitle, subtitle: String(subtitle || '') });
    const token = room.beginStartBy(uid, { title: cleanTitle, subtitle: String(subtitle || ''), announce: `${name} a lancé « ${label} »` });
    if (!token) {
      publish(room);
      return reply.code(403).send({ error: 'Seuls l’hôte et les co-pilotes lancent une vidéo : propose-la plutôt.' });
    }
    publish(room);
    try {
      let streams = [stream];
      let pick = null;
      if (auto) {
        const want = lang === 'fr' || lang === 'vo' ? lang : null;
        ({ streams, pick } = await orderedSources(keys, { want, meta, log: request.log }));
        if (!streams.length) throw new Error('Aucune source utilisable (toutes trop grosses pour le serveur ?)');
        if (!room.isCurrentStart(token)) return { ok: true, superseded: true };
      }
      const loaded = await startMedia(room, { token, streams, pick, title, subtitle, poster, meta, startAt, startedBy: name, starterUid: uid, log: request.log });
      return { ok: true, superseded: !loaded };
    } catch (err) {
      // Failed before a source was even tried (startMedia tells the room itself otherwise).
      if (room.failStart(token)) {
        publish(room);
        notice(room.id, `Impossible de lancer « ${label} » : ${err.message}`);
      }
      return reply.code(502).send({ error: err.message });
    }
  });

  /** Suggests a title/episode to the room (optionally with the source the proposer chose). */
  api.post('/api/room/propose', async (request, reply) => {
    const { uid } = request.session;
    const item = cleanProposal(request.body);
    if (!item) return reply.code(400).send({ error: 'Proposition invalide' });
    const room = rooms.peek(request.session.room);
    if (!room) return reply.code(409).send({ error: 'Tu n’es pas connecté à la salle' });
    // Only the opaque key and a short label are kept: the stream stays in the server cache.
    const stream = item.streamKey ? addons.lookupStream(item.streamKey) : null;
    const result = room.propose(uid, {
      ...item,
      streamKey: stream ? item.streamKey : null,
      source: stream ? addons.sourceLabel(stream) : null,
    });
    if (result.error) {
      publish(room);
      return reply.code(400).send({ error: result.error });
    }
    publish(room);
    return { ok: true, id: result.item.id, duplicate: !!result.duplicate };
  });

  /** Torrent download health (peers, speed vs the stream's bitrate) for the player's indicator. */
  api.get('/api/media/:sid/health', async (request, reply) => {
    const media = getSession(request.params.sid);
    if (!media) return reply.code(404).send({ error: 'Session inconnue' });
    if (!media.torrent) return { kind: 'http' };
    const health = await fetchTorrentHealth(media).catch(() => null);
    return health ? { kind: 'torrent', ...health } : { kind: 'torrent', engine: media.torrent.engine, level: 'unknown' };
  });

  /** Private file URL for an external player (VLC, Infuse...), plus where the room is. */
  const externalLimit = new RateLimiter({ max: 20, windowMs: 60_000 });
  api.post('/api/media/:sid/external', async (request, reply) => {
    const { sid } = request.params;
    const { uid } = request.session;
    const room = rooms.peek(request.session.room);
    if (!room || room.status(uid) !== 'member' || room.media?.sid !== sid) return reply.code(409).send({ error: 'Cette vidéo ne passe plus dans ta salle' });
    const media = getSession(sid);
    if (!media) return reply.code(404).send({ error: 'Session inconnue' });
    if (!externalLimit.allow(uid)) return reply.code(429).send({ error: 'Trop de demandes, réessaie dans une minute' });
    const name = safeFileName(media.fileName);
    return {
      url: fileUrl(siteBase(request), sid, signFileToken(sid, uid), name),
      name,
      title: mediaLabel(room.media),
      position: room.currentPosition(),
    };
  });

  /** "Ouvrir sur le site": a one-time link that logs the same account into the same room. */
  api.post('/api/handoff', async (request, reply) => {
    const { uid, name, avatar, room } = request.session;
    if (!handoffLimit.allow(uid)) return reply.code(429).send({ error: 'Trop de demandes, réessaie dans une minute' });
    const code = handoffs.create({ uid, name, avatar }, room);
    return { url: `${siteBase(request)}/?handoff=${code}` };
  });

  /** External subtitles of what a media session plays (each viewer picks their own). */
  const subtitleLists = new Map();
  api.get('/api/subtitles/:sid', async (request, reply) => {
    const media = getSession(request.params.sid);
    if (!media) return reply.code(404).send({ error: 'Session inconnue' });
    const meta = media.meta;
    if (!meta?.videoId || !config.subtitleAddons.length) return { items: [] };
    // The file's OpenSubtitles hash finds subtitles timed for this exact release. Not
    // fatal: without it the addon still answers by name and by title.
    const file = await ensureFileHash(media, 10000).catch((err) => {
      request.log.debug({ err: err.message }, 'video hash unavailable');
      return media.file;
    });
    const cacheKey = `${meta.type}:${meta.videoId}:${file?.hash || ''}:${file?.name || ''}`;
    let entry = subtitleLists.get(cacheKey);
    if (!entry || entry.expires < Date.now()) {
      // One query per video file for the whole room, shared for 30 min.
      entry = { items: listSubtitles(meta.type, meta.videoId, request.log, file), expires: Date.now() + 30 * 60 * 1000 };
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

  api.post('/api/room/stop', async (request, reply) => {
    const room = rooms.peek(request.session.room);
    if (!room?.media) return { ok: true };
    const stopped = room.stopBy(request.session.uid);
    publish(room);
    if (!stopped) return reply.code(403).send({ error: 'Seuls l’hôte et les co-pilotes peuvent arrêter la lecture' });
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
  // Website rooms have a waiting room; the owner of a personal room always gets in.
  const web = session.room.startsWith('web:');
  const code = web ? session.room.slice(4) : null;
  const lobby = web || session.room.startsWith('devlobby:');
  const room = rooms.get(session.room, { lobby, owner: web && personalRoomCode(session.uid) === code ? session.uid : null });
  if (room.status(session.uid) === 'blocked') {
    ws.send(JSON.stringify({ t: 'kicked', reason: 'kicked' }));
    ws.close(4003, 'blocked');
    return;
  }
  ws.uid = session.uid;
  if (!sockets.has(room.id)) sockets.set(room.id, new Set());
  sockets.get(room.id).add(ws);

  if (room.join(session)) publish(room);
  else ws.send(stateFor(room, session.uid, JSON.stringify({ t: 'state', ...room.snapshot() })));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg?.t) {
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
        return;
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
        break;
    }
    if (!floodLimit.allow(session.uid)) return;
    // Every action goes through the room's permissions and per-person limits.
    if (handleRoomMessage(room, session.uid, msg) || room.outbox.length) publish(room);
  });

  ws.on('close', () => {
    const set = sockets.get(room.id);
    set?.delete(ws);
    if (set && !set.size) sockets.delete(room.id);
    // The room itself is kept (paused when empty): the film survives a reconnect or
    // everybody leaving for a moment. Rooms.sweep forgets it after EMPTY_ROOM_TTL_MS.
    if (room.leave(session.uid)) publish(room);
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
  if (!isAllowedHlsPath(rest) && !parseGpuPath(rest)) return reply.code(400).send({ error: 'Chemin invalide' });

  const parsed = parseProfile(profile);
  // Qualities the host's GPU encoder makes come from it; the rest from the converter.
  if (parsed && (await encoders.hls(request, reply, session, parsed, rest))) return reply;
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
