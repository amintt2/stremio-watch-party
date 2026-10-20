import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import Fastify from 'fastify';
import { config } from '../src/config.js';
import {
  EXTERNAL_TTL_S,
  HANDOFF_TTL_MS,
  Handoffs,
  fileUrl,
  guessType,
  issueRoomPass,
  proxyFile,
  safeFileName,
  signFileToken,
  verifyFileToken,
  verifyRoomPass,
} from '../src/external.js';
import { Room } from '../src/rooms.js';
import { handleRoomMessage } from '../src/roomSocket.js';

config.sessionSecret = 'test-secret';

test('file tokens are bound to the session, the viewer and expire after 12 h', () => {
  const now = 1_700_000_000_000;
  const token = signFileToken('sid1', 'discord:42', now);
  assert.match(token, /^[\w-]+\.\d+\.[\w-]+$/, 'URL-safe path segment');
  assert.equal(verifyFileToken('sid1', token, now), 'discord:42');
  assert.equal(verifyFileToken('sid1', token, now + (EXTERNAL_TTL_S - 1) * 1000), 'discord:42');
  assert.equal(verifyFileToken('sid1', token, now + (EXTERNAL_TTL_S + 1) * 1000), null, 'expired');
  assert.equal(verifyFileToken('sid2', token, now), null, 'other media session');

  const [who, exp, sig] = token.split('.');
  const other = Buffer.from('discord:43').toString('base64url');
  assert.equal(verifyFileToken('sid1', `${other}.${exp}.${sig}`, now), null, 'other viewer');
  assert.equal(verifyFileToken('sid1', `${who}.${Number(exp) + 3600}.${sig}`, now), null, 'extended expiry');
  assert.equal(verifyFileToken('sid1', `${who}.${exp}.${sig.slice(0, -1)}`, now), null, 'truncated mac');
  assert.equal(verifyFileToken('sid1', 'garbage', now), null);
  assert.equal(verifyFileToken('sid1', undefined, now), null);

  config.sessionSecret = 'other-secret';
  assert.equal(verifyFileToken('sid1', token, now), null, 'other server secret');
  config.sessionSecret = 'test-secret';
});

test('file names are cosmetic and safe', () => {
  assert.equal(safeFileName('The.Matrix.1999.1080p.BluRay.x264.mkv'), 'The.Matrix.1999.1080p.BluRay.x264.mkv');
  assert.equal(safeFileName('Amélie (2001) [VF].mp4'), 'Amelie (2001) [VF].mp4');
  assert.equal(safeFileName('../../etc/passwd'), 'etc_passwd.mkv');
  assert.equal(safeFileName('a/b?c#d"e.mkv'), 'a_b_c_d_e.mkv');
  assert.equal(safeFileName(''), 'video.mkv');
  assert.equal(safeFileName(null), 'video.mkv');
  assert.equal(safeFileName('Film sans extension'), 'Film sans extension.mkv');
  assert.equal(guessType('a.mkv'), 'video/x-matroska');
  assert.equal(guessType('a.MP4'), 'video/mp4');
  assert.equal(guessType('a.bin'), 'application/octet-stream');
  assert.equal(fileUrl('https://w.example', 's/1', 'tok', 'Mon film.mkv'), 'https://w.example/api/media/s%2F1/file/tok/Mon%20film.mkv');
});

// ---------------------------------------------------------------- range proxy

const DATA = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));

/** Upstream like a Stremio/Huwa engine: octet-stream, Range support, HEAD optional. */
async function upstream({ head = true } = {}) {
  const seen = { aborted: 0, ranges: [], methods: [] };
  const server = createServer((req, res) => {
    seen.methods.push(req.method);
    seen.ranges.push(req.headers.range || null);
    if (req.url === '/slow') {
      // Endless body: the proxy must hang up when its client does.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 5);
      res.on('close', () => {
        clearInterval(timer);
        seen.aborted++;
      });
      return;
    }
    if (req.method === 'HEAD' && !head) {
      res.writeHead(405).end();
      return;
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1] || 0);
      const end = m[2] ? Math.min(Number(m[2]), DATA.length - 1) : DATA.length - 1;
      if (start >= DATA.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${DATA.length}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${DATA.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'X-Upstream-Secret': 'debrid-key',
      });
      res.end(req.method === 'HEAD' ? undefined : DATA.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': DATA.length, 'Accept-Ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : DATA);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function proxyApp(target) {
  const app = Fastify();
  app.route({ method: ['GET', 'HEAD'], url: '/file/:name', handler: (request, reply) => proxyFile(request, reply, target, { name: request.params.name }) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

test('the file proxy passes Range through (206) and never leaks the upstream', async (t) => {
  const up = await upstream();
  const px = await proxyApp(`${up.url}/media`);
  t.after(() => (up.server.closeAllConnections(), up.server.close(), px.app.close()));

  const full = await fetch(`${px.url}/file/Film.mkv`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/x-matroska', 'octet-stream replaced by the extension type');
  assert.equal(full.headers.get('content-length'), String(DATA.length));
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('content-disposition'), /inline; filename="Film.mkv"/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), DATA);

  const part = await fetch(`${px.url}/file/Film.mkv`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${DATA.length}`);
  assert.equal(part.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), DATA.subarray(100, 200));
  assert.equal(up.seen.ranges.at(-1), 'bytes=100-199');

  const open = await fetch(`${px.url}/file/Film.mkv`, { headers: { Range: 'bytes=9990-' } });
  assert.equal(open.status, 206);
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), DATA.subarray(9990));

  const past = await fetch(`${px.url}/file/Film.mkv`, { headers: { Range: 'bytes=20000-' } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${DATA.length}`);

  // A malformed Range is not forwarded (whole file instead).
  const bad = await fetch(`${px.url}/file/Film.mkv`, { headers: { Range: 'bytes=abc\r\nX: 1' } }).catch(() => null);
  if (bad) assert.equal(bad.status, 200);

  for (const res of [full, part]) {
    assert.equal(res.headers.get('x-upstream-secret'), null);
    assert.equal(res.headers.get('location'), null);
    for (const [, v] of res.headers) assert.ok(!v.includes('127.0.0.1:' + up.server.address().port), 'upstream address hidden');
  }
});

test('HEAD works, even when the upstream refuses HEAD', async (t) => {
  for (const head of [true, false]) {
    const up = await upstream({ head });
    const px = await proxyApp(`${up.url}/media`);
    t.after(() => (up.server.closeAllConnections(), up.server.close(), px.app.close()));
    const res = await fetch(`${px.url}/file/Film.mp4`, { method: 'HEAD', headers: { Range: 'bytes=0-' } });
    assert.equal(res.status, 206, `upstream HEAD ${head}`);
    assert.equal(res.headers.get('content-length'), String(DATA.length));
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    if (!head) assert.deepEqual(up.seen.methods, ['HEAD', 'GET']);
  }
});

test('the upstream request is aborted when the player hangs up', async (t) => {
  const up = await upstream();
  const px = await proxyApp(`${up.url}/slow`);
  t.after(() => (up.server.closeAllConnections(), up.server.close(), px.app.close()));
  // A raw client that hangs up after the first bytes, like VLC seeking elsewhere.
  await new Promise((resolve) => {
    const req = httpGet(`${px.url}/file/Film.mkv`, (res) => res.once('data', () => (req.destroy(), resolve())));
  });
  for (let i = 0; i < 100 && !up.seen.aborted; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(up.seen.aborted, 1);
});

test('an upstream error is a 502 without details', async (t) => {
  const px = await proxyApp('http://127.0.0.1:1/nothing');
  t.after(() => px.app.close());
  const res = await fetch(`${px.url}/file/Film.mkv`);
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('127.0.0.1:1'));
});

// ---------------------------------------------------------------- handoff

test('handoff codes are single-use and expire after 5 minutes', () => {
  let t = 1_000_000;
  const handoffs = new Handoffs({ now: () => t });
  const user = { uid: 'discord:1', name: 'Alice', avatar: null };
  const code = handoffs.create(user, 'discord:inst');
  assert.match(code, /^[\w-]{32}$/);
  assert.deepEqual(handoffs.consume(code), { user, room: 'discord:inst', expires: 1_000_000 + HANDOFF_TTL_MS });
  assert.equal(handoffs.consume(code), null, 'second use refused');

  const late = handoffs.create(user, 'discord:inst');
  t += HANDOFF_TTL_MS + 1;
  assert.equal(handoffs.consume(late), null, 'expired');
  assert.equal(handoffs.consume(''), null);
  assert.equal(handoffs.consume(undefined), null);
  assert.equal(handoffs.consume('made-up'), null);

  handoffs.create(user, 'r');
  t += HANDOFF_TTL_MS + 1;
  handoffs.sweep();
  assert.equal(handoffs.codes.size, 0, 'expired codes are forgotten');
});

test('room passes only work for their own account', () => {
  const now = 1_700_000_000_000;
  const pass = issueRoomPass({ uid: 'discord:1', room: 'discord:inst' }, now);
  assert.equal(verifyRoomPass(pass, 'discord:1', now), 'discord:inst');
  assert.equal(verifyRoomPass(pass, 'discord:2', now), null, 'someone else');
  assert.equal(verifyRoomPass(pass, 'discord:1', now + 13 * 3600 * 1000), null, 'expired');
  assert.equal(verifyRoomPass(`${pass}x`, 'discord:1', now), null);
  assert.equal(verifyRoomPass(undefined, 'discord:1', now), null);
});

// ---------------------------------------------------------------- the room and external viewers

const MEDIA = { sid: 's1', duration: 3600, qualities: [] };

test('the room never waits for a viewer in an external player', () => {
  let t = 0;
  const room = new Room('r', { now: () => t });
  room.join({ uid: 'a', name: 'A' });
  room.join({ uid: 'b', name: 'B' });
  room.load(MEDIA);
  assert.deepEqual([...room.waiting.keys()], ['a', 'b']);

  // b goes external during the load barrier: no more waiting for them.
  assert.equal(handleRoomMessage(room, 'b', { t: 'external', value: true }), true);
  assert.deepEqual([...room.waiting.keys()], ['a']);
  assert.equal(handleRoomMessage(room, 'b', { t: 'external', value: 'yes' }), false, 'validated');
  room.setBuffering('a', false);
  assert.equal(room.running, true);

  // Their stall reports are ignored while external.
  t += 5000;
  assert.equal(room.setBuffering('b', true), false);
  assert.equal(room.running, true);
  assert.equal(room.snapshot().members.find((m) => m.uid === 'b').external, true);
  assert.equal(room.snapshot().members.find((m) => m.uid === 'a').external, undefined);

  // A new media doesn't wait for them either.
  room.load({ ...MEDIA, sid: 's2' });
  assert.deepEqual([...room.waiting.keys()], ['a']);

  // Back to the integrated player: waited for again at the next film.
  room.setBuffering('a', false);
  assert.equal(room.setExternal('b', false), true);
  room.load({ ...MEDIA, sid: 's3' });
  assert.deepEqual([...room.waiting.keys()].sort(), ['a', 'b']);
});
