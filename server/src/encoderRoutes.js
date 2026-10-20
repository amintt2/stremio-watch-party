// HTTP side of the GPU encoder (see encoder.js): pairing and downloads for the site,
// socket / source / segment upload for the app, and the HLS paths served from it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { config } from './config.js';
import { converterParams } from './media.js';
import { proxyFile } from './external.js';
import { RateLimiter } from './roomSocket.js';
import { EncoderHub, masterPlaylist, mediaPlaylist, newKey, parseGpuPath } from './encoder.js';

/** Builds offered for download (encoder/build.sh writes them to ENCODER_DIST_DIR). */
export const PLATFORMS = {
  windows: { label: 'Windows', file: 'watchparty-encoder-windows-amd64.exe', name: 'WatchParty-Encodeur.exe' },
  'macos-arm64': { label: 'macOS (Apple Silicon)', file: 'watchparty-encoder-darwin-arm64', name: 'WatchParty-Encodeur-macOS.zip', zip: true },
  'macos-intel': { label: 'macOS (Intel)', file: 'watchparty-encoder-darwin-amd64', name: 'WatchParty-Encodeur-macOS-Intel.zip', zip: true },
  linux: { label: 'Linux', file: 'watchparty-encoder-linux-amd64', name: 'WatchParty-Encodeur-Linux.zip', zip: true },
};

const TICKET_TTL_MS = 10 * 60 * 1000;
const CONFIG_NAME = 'watchparty-encoder.json';

/**
 * The Windows .exe carries its settings at its very end (after the program, which
 * Windows ignores): one double-click and it is connected. The app reads the last
 * kilobytes of its own file for this marker.
 */
export function withTrailer(binary, settings) {
  const payload = Buffer.from(JSON.stringify(settings)).toString('base64');
  return Buffer.concat([binary, Buffer.from(`\n#WPCFG#${payload}#END#\n`)]);
}

/** Minimal .zip (stored, no compression): the app + its settings file, executable bit kept. */
export function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of files) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix: external attributes are a file mode
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const bearer = (request) => /^Bearer\s+(\S+)$/i.exec(request.headers.authorization || '')?.[1] || null;

/** The site's address as the app must reach it (PUBLIC_URL, else the request's own). */
function serverUrl(request) {
  if (config.publicUrl) return config.publicUrl;
  const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http';
  return `${proto}://${request.headers['x-forwarded-host'] || request.headers.host}`;
}

/**
 * Registers the routes and returns { hub, attach(room, session), hls(...) }.
 * `publish(room)` sends a room's new state; `getSession(sid)` finds media sessions.
 */
export function registerEncoder(app, { store, rooms, publish, getSession, requireSession }) {
  const roomOf = (sid) => {
    for (const room of rooms) if (room.media?.sid === sid) return room;
    return null;
  };
  /** Whose encoder works for a room: who started the film, the host, then anyone there. */
  const candidates = (room) => [...new Set([room.media?.startedByUid, room.host, ...room.members.keys()].filter(Boolean))];

  const hub = new EncoderHub({
    keys: (id) => store.encoderKey(id),
    log: app.log,
    cacheBytes: config.gpuCacheBytes,
    onChange: (sid) => {
      const room = roomOf(sid);
      if (room && room.setEncoder(sid, hub.describe(getSession(sid)?.gpu))) publish(room);
    },
    // An encoder came online: it takes over the films playing in its owner's rooms.
    onAgents: (uid) => {
      for (const room of rooms) {
        if (!room.media || !room.members.has(uid)) continue;
        const session = getSession(room.media.sid);
        if (!session || session.gpu) continue;
        // A fresh start of the app gets its chance right away, even after a failure.
        if (hub.online(uid)) session.gpuRetryAt = 0;
        hub.attach(session, candidates(room));
      }
    },
  });

  // Films nobody plays anymore: the app stops encoding them. Films taken back after a
  // failure go back to an online app once their wait is over.
  setInterval(() => {
    for (const job of [...hub.jobs.values()]) if (!roomOf(job.sid)) hub.detach(job, 'Plus personne ne regarde');
    for (const room of rooms) {
      const session = room.media && getSession(room.media.sid);
      if (session && !session.gpu && session.gpuRetryAt) hub.attach(session, candidates(room));
    }
  }, 15_000).unref();

  const pairLimit = new RateLimiter({ max: 10, windowMs: 60_000 });
  /** One-time download tickets: uid → a key is made when the file is fetched. */
  const tickets = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of tickets) if (v.expires < t) tickets.delete(k);
  }, 60_000).unref();

  // ------------------------------------------------------------ site (session)

  app.register(async (api) => {
    api.addHook('preHandler', requireSession);

    api.get('/api/encoder', async (request) => ({
      status: hub.status(request.session.uid),
      keys: store.listEncoderKeys(request.session.uid),
      platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label, available: existsSync(join(config.encoderDistDir, p.file)) })),
    }));

    /** A one-time link to download the app already paired with this account. */
    api.post('/api/encoder/pair', async (request, reply) => {
      if (!pairLimit.allow(request.session.uid)) return reply.code(429).send({ error: 'Trop de demandes, réessaie dans une minute' });
      const platform = String(request.body?.platform || '');
      const p = PLATFORMS[platform];
      if (!p) return reply.code(400).send({ error: 'Système inconnu' });
      if (!existsSync(join(config.encoderDistDir, p.file))) return reply.code(404).send({ error: 'Encodeur pas encore disponible sur ce serveur' });
      if (store.listEncoderKeys(request.session.uid).length >= 10) return reply.code(429).send({ error: 'Trop de PC jumelés : supprimes-en un' });
      const ticket = randomBytes(18).toString('base64url');
      tickets.set(ticket, { uid: request.session.uid, name: request.session.name, platform, expires: Date.now() + TICKET_TTL_MS });
      return { url: `${serverUrl(request)}/api/encoder/download/${ticket}` };
    });

    api.delete('/api/encoder/keys/:id', async (request, reply) => {
      const id = String(request.params.id);
      if (!store.removeEncoderKey(request.session.uid, id)) return reply.code(404).send({ error: 'Introuvable' });
      // 4001: the app knows at once its key was removed (4000 would mean "used elsewhere").
      hub.agents.get(id)?.close(4001);
      return { ok: true };
    });
  });

  // Opened in a real browser (from the Activity too): the ticket is the authorization.
  app.get('/api/encoder/download/:ticket', async (request, reply) => {
    const entry = tickets.get(request.params.ticket);
    tickets.delete(request.params.ticket);
    if (!entry || entry.expires < Date.now()) return reply.code(410).type('text/plain; charset=utf-8').send('Lien expiré : redemande-le depuis Watch Party.');
    const p = PLATFORMS[entry.platform];
    const path = join(config.encoderDistDir, p.file);
    if (!existsSync(path)) return reply.code(404).send();
    // Checked again here: tickets asked for in advance must not get past the limit.
    if (store.listEncoderKeys(entry.uid).length >= 10) return reply.code(429).type('text/plain; charset=utf-8').send('Trop de PC jumelés : supprimes-en un dans Paramètres → Encodeur GPU.');
    const key = newKey();
    const date = new Date().toLocaleDateString('fr-FR');
    store.addEncoderKey(entry.uid, { id: key.id, hash: key.hash, label: `${p.label} · ${date}` });
    const settings = { server: serverUrl(request), key: key.token };
    const binary = readFileSync(path);
    const body = p.zip
      ? zipFiles([
          { name: p.file.replace(/-(?:darwin|linux)-(?:arm64|amd64)$/, ''), data: binary, mode: 0o755 },
          // The pairing key: readable by this user only.
          { name: CONFIG_NAME, data: Buffer.from(JSON.stringify(settings, null, 2)), mode: 0o600 },
        ])
      : withTrailer(binary, settings);
    reply.header('Content-Disposition', `attachment; filename="${p.name}"`).header('Cache-Control', 'no-store');
    return reply.type(p.zip ? 'application/zip' : 'application/vnd.microsoft.portable-executable').send(body);
  });

  // ------------------------------------------------------------ app (pairing key)

  // Header only: a key in the URL would end up in proxy logs.
  const agentKey = (request) => hub.authenticate(bearer(request));

  app.get('/api/encoder/ws', { websocket: true }, (ws, request) => {
    const key = agentKey(request);
    if (!key) {
      ws.close(4001, 'unauthorized');
      return;
    }
    store.touchEncoderKey(key.id);
    const agent = hub.connect(
      key,
      (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj)),
      (code = 4000) => ws.close(code, code === 4001 ? 'unauthorized' : 'replaced')
    );
    const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      hub.message(agent, msg);
    });
    ws.on('close', () => {
      clearInterval(ping);
      hub.disconnect(agent);
    });
  });

  // ------------------------------------------------------------ app updates (update.go)

  /** Builds this server offers, with their SHA-256 (cached: they change only with a redeploy). */
  let builds = null;
  function encoderBuilds() {
    if (builds) return builds;
    const files = {};
    for (const p of Object.values(PLATFORMS)) {
      const path = join(config.encoderDistDir, p.file);
      if (existsSync(path)) files[p.file] = { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    }
    const versionFile = join(config.encoderDistDir, 'VERSION');
    const found = { version: existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null, files };
    // Not kept while nothing is there yet (a build still being copied): asked again next time.
    if (found.version && Object.keys(files).length) builds = found;
    return found;
  }

  /** The version the app should run (the one built with this server), for paired apps. */
  app.get('/api/encoder/latest', async (request, reply) => {
    if (!agentKey(request)) return reply.code(401).send();
    const b = encoderBuilds();
    if (!b.version) return reply.code(404).send({ error: 'Pas de version publiée sur ce serveur' });
    return b;
  });

  /** The build itself (no settings inside: the app keeps its own). */
  app.get('/api/encoder/update/:file', async (request, reply) => {
    if (!agentKey(request)) return reply.code(401).send();
    const file = String(request.params.file);
    if (!Object.hasOwn(encoderBuilds().files, file)) return reply.code(404).send();
    return reply
      .type('application/octet-stream')
      .header('Cache-Control', 'no-store')
      .send(readFileSync(join(config.encoderDistDir, file)));
  });

  /** The film's file, for the app (Range passthrough; the real source URL stays here). */
  // ffmpeg reads it with the job's own short token (?t=), not the pairing key: a command
  // line is visible to other users of the PC, and the token dies with the job.
  app.get('/api/encoder/source/:job', async (request, reply) => {
    const job = hub.jobs.get(String(request.params.job));
    const key = agentKey(request);
    const allowed = job && ((key && job.agent.id === key.id) || hub.sourceTokenMatches(job, request.query?.t));
    if (!allowed) return reply.code(403).send();
    return proxyFile(request, reply, job.session.mediaURL, { name: job.session.fileName || 'video.mkv', guard: !job.session.torrent });
  });

  app.register(async (uploads) => {
    // Checked before the body is read: no one without a key makes the server buffer 32 MB.
    uploads.addHook('onRequest', async (request, reply) => {
      request.encoderKey = agentKey(request);
      if (!request.encoderKey) return reply.code(401).send();
    });
    // A 4 s segment is ~8 MB at 4K (16 Mb/s): room to spare, not to abuse.
    uploads.addContentTypeParser(['video/mp2t', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 32 * 1024 ** 2 }, (req, body, done) => done(null, body));
    uploads.put('/api/encoder/segment/:job/:rendition/:index', async (request, reply) => {
      const key = request.encoderKey;
      const { job, rendition, index } = request.params;
      if (!Buffer.isBuffer(request.body) || !request.body.length) return reply.code(400).send();
      const ok = hub.upload(key.id, job, rendition, Number(index), request.body);
      return reply.code(ok ? 204 : 409).send();
    });
  });

  // ------------------------------------------------------------ HLS from the encoder

  /**
   * Serves a relay path from the encoder when it handles this quality (transcoding:
   * the server only copies). Returns false to let the Stremio converter do it.
   */
  async function hls(request, reply, session, parsed, rest) {
    const job = session.gpu;
    const gpuPath = parseGpuPath(rest);
    if (!job || !hub.serves(job, parsed.quality) || converterParams(session.sid, session.info, parsed.quality, parsed.caps)?.mode !== 'transcode') {
      // An old GPU playlist after the encoder left: hls.js reloads from master.m3u8.
      if (gpuPath) {
        reply.code(410).send({ error: 'Encodeur parti' });
        return true;
      }
      return false;
    }
    reply.header('Cache-Control', 'no-store');
    const info = session.info;
    if (rest === 'master.m3u8') {
      const text = masterPlaylist(parsed.quality, info);
      if (!text) return false;
      // The first segments asked will be these: one start for both.
      job.active.set(`v${parsed.quality}`, Date.now());
      if ((info.audio || []).length) job.active.set('a0', Date.now());
      reply.type('application/vnd.apple.mpegurl').send(text);
      return true;
    }
    if (!gpuPath) return false;
    const audioIndex = gpuPath.rendition.startsWith('a') ? Number(gpuPath.rendition.slice(1)) : null;
    if (audioIndex !== null && audioIndex >= (info.audio || []).length) {
      reply.code(404).send();
      return true;
    }
    if (gpuPath.kind === 'playlist') {
      reply.type('application/vnd.apple.mpegurl').send(mediaPlaylist(info.duration, audioIndex === null ? 'gv' : `ga${audioIndex}`));
      return true;
    }
    const abort = new AbortController();
    request.raw.on('close', () => abort.abort());
    try {
      const buf = await hub.segment(job, parsed.quality, gpuPath.rendition, gpuPath.index, abort.signal);
      hub.served(job);
      reply.type('video/mp2t').send(buf);
    } catch (err) {
      if (!abort.signal.aborted) reply.code(err.status || 503).send({ error: err.message });
    }
    return true;
  }

  return {
    hub,
    hls,
    /** A new film in a room: an online encoder of someone there takes it. */
    attach(room, session) {
      hub.attach(session, candidates(room));
    },
    /** GPU part of the player's statistics. */
    state(room, session) {
      return hub.state(session, room ? candidates(room) : []);
    },
  };
}
