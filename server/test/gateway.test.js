import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, isPublicHost, publicOrigin, routeOf } from '../src/gateway.js';

const HASH = 'a'.repeat(40);

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Fake upstream recording what it was asked. */
async function upstream(name) {
  const seen = [];
  const s = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, range: req.headers.range });
      if (req.url === '/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'x' });
        return res.end(JSON.stringify({ baseUrl: 'http://172.18.0.7:11470', values: { cacheSize: 1 } }));
      }
      if (req.headers.range) {
        res.writeHead(206, { 'Content-Range': 'bytes 0-3/10', 'Accept-Ranges': 'bytes' });
        return res.end('0123');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: name }));
    });
  });
  return { ...s, seen };
}

async function setup({ huwaDown = false } = {}) {
  const huwa = await upstream('huwa');
  const stremio = await upstream('stremio');
  if (huwaDown) await new Promise((r) => huwa.server.close(r));
  const gw = await listen(
    createGateway({
      huwaUrl: huwa.url,
      huwaMediaUrl: 'http://huwa:8080',
      stremioUrl: stremio.url,
      stremioSelfUrl: 'http://127.0.0.1:11470',
      engine: 'huwa',
      log: {},
    }),
  );
  const call = (path, init = {}) =>
    fetch(gw.url + path, { ...init, headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'stream.example.com', ...init.headers } });
  const close = () => Promise.all([huwa, stremio, gw].map((s) => new Promise((r) => s.server.close(r)).catch(() => {})));
  return { huwa, stremio, call, close };
}

test('routes: torrents, Stremio routes, the rest refused', () => {
  assert.deepEqual(routeOf(`/${HASH}/create`), { to: 'torrent', hash: HASH });
  assert.deepEqual(routeOf(`/${HASH.toUpperCase()}/3`), { to: 'torrent', hash: HASH });
  assert.deepEqual(routeOf(`/${HASH}/3/stats.json`), { to: 'torrent', hash: HASH });
  assert.deepEqual(routeOf('/create'), { to: 'torrent', hash: null });
  assert.deepEqual(routeOf('/hlsv2/abc/master.m3u8'), { to: 'stremio' });
  assert.deepEqual(routeOf('/opensubHash'), { to: 'stremio' });
  assert.equal(routeOf('/local-addon/manifest.json'), null);
  assert.equal(routeOf('/api/rooms'), null);
});

test('private addresses are recognised', () => {
  for (const h of ['localhost', 'huwa', 'stremio', '127.0.0.1', '10.0.0.2', '172.18.0.7', '192.168.1.1', '169.254.169.254', '[::1]', 'fd00::1', 'x.internal']) {
    assert.equal(isPublicHost(h), false, h);
  }
  for (const h of ['real-debrid.com', 'download.example.org', '8.8.8.8', '172.32.0.1']) assert.equal(isPublicHost(h), true, h);
  assert.equal(publicOrigin({ 'x-forwarded-proto': 'https', host: 'stream.example.com' }), 'https://stream.example.com');
});

test('settings: baseUrl is the public address, POST changes nothing', async () => {
  const t = await setup();
  try {
    const res = await t.call('/settings');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal((await res.json()).baseUrl, 'https://stream.example.com/');
    const post = await t.call('/settings', { method: 'POST', body: '{"cacheSize":0}', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await post.json(), { success: true });
    assert.equal(t.stremio.seen.filter((r) => r.method === 'POST').length, 0);
  } finally {
    await t.close();
  }
});

test('torrents open on Huwa; the converter reads them from Huwa', async () => {
  const t = await setup();
  try {
    const create = await t.call(`/${HASH}/create`, { method: 'POST', body: '{"peerSearch":null}', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await create.json(), { from: 'huwa' });
    assert.equal(t.huwa.seen[0].body, '{"peerSearch":null}');

    const part = await t.call(`/${HASH}/0`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '0123');
    assert.equal(t.huwa.seen[1].range, 'bytes=0-3');

    const mediaURL = `https://stream.example.com/${HASH}/0`;
    await (await t.call(`/hlsv2/probe?mediaURL=${encodeURIComponent(mediaURL)}`)).json();
    const asked = new URL(t.stremio.seen.at(-1).url, 'http://x');
    assert.equal(asked.pathname, '/hlsv2/probe');
    assert.equal(asked.searchParams.get('mediaURL'), `http://huwa:8080/${HASH}/0`);

    // Segments come back with that internal URL in their query: still accepted.
    const seg = await t.call(`/hlsv2/x/video0/segment1.m4s?mediaURL=${encodeURIComponent(`http://huwa:8080/${HASH}/0`)}`);
    assert.equal(seg.status, 200);
  } finally {
    await t.close();
  }
});

test('Huwa down: the torrent opens on the Stremio engine, and stays there', async () => {
  const t = await setup({ huwaDown: true });
  try {
    const create = await t.call(`/${HASH}/create`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await create.json(), { from: 'stremio' });
    await t.call(`/${HASH}/0`);
    assert.equal(t.stremio.seen.at(-1).url, `/${HASH}/0`);
    await t.call(`/hlsv2/probe?mediaURL=${encodeURIComponent(`https://stream.example.com/${HASH}/0`)}`);
    assert.equal(new URL(t.stremio.seen.at(-1).url, 'http://x').searchParams.get('mediaURL'), `http://127.0.0.1:11470/${HASH}/0`);
  } finally {
    await t.close();
  }
});

test('the private network is out of reach, unknown routes too', async () => {
  const t = await setup();
  try {
    for (const target of ['http://watch-party:3001/api/health', 'http://169.254.169.254/latest', 'http://127.0.0.1:8080/api/v1/session']) {
      const res = await t.call(`/hlsv2/probe?mediaURL=${encodeURIComponent(target)}`);
      assert.equal(res.status, 403, target);
    }
    const proxy = await t.call(`/proxy/${encodeURIComponent('d=http://huwa:8080')}/api/v1/session`);
    assert.equal(proxy.status, 403);
    assert.equal((await t.call('/local-addon/manifest.json')).status, 404);
    const pre = await t.call(`/${HASH}/create`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    // A public debrid link goes through untouched.
    const ok = await t.call(`/hlsv2/probe?mediaURL=${encodeURIComponent('https://dl.example.org/f.mkv')}`);
    assert.equal(ok.status, 200);
    assert.equal(new URL(t.stremio.seen.at(-1).url, 'http://x').searchParams.get('mediaURL'), 'https://dl.example.org/f.mkv');
  } finally {
    await t.close();
  }
});
