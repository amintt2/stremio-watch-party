import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlsRelay, SILENT_AUDIO_BYTES } from '../src/hlsRelay.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A Stremio converter as /hlsv2 behaves: one ffmpeg per track making segments in order;
 * any other segment restarts it (a "seek") and cancels the one in progress.
 */
function fakeStremio({ segmentMs = 5, destroyed = new Set() } = {}) {
  const calls = [];
  const tracks = new Map();
  const fetch = async (session, params, rest) => {
    calls.push({ id: params.convertId, rest });
    if (destroyed.has(params.convertId)) return new Response('{"error":{"message":"Failed: MasterConverter is destroyed"}}', { status: 500 });
    if (rest.endsWith('.m3u8')) return new Response(`#EXTM3U\n#EXT-X-MAP:URI="video0/init.mp4?mediaURL=secret"\nvideo0/segment1.m4s?mediaURL=secret\n`);
    const m = /^(\w+)\/segment(\d+)\.m4s$/.exec(rest);
    if (!m) return new Response(Buffer.from('init'));
    const key = `${params.convertId}/${m[1]}`;
    const t = tracks.get(key) || { next: null, current: null, seeks: 0, cancels: 0 };
    tracks.set(key, t);
    const seq = Number(m[2]);
    if (t.current !== null) t.cancels++;
    if (seq !== t.next) t.seeks++;
    t.current = seq;
    const mine = {};
    t.token = mine;
    await tick(segmentMs);
    if (t.token !== mine) return new Response('{"error":{"message":"Segment is canceled"}}', { status: 500 });
    t.current = null;
    t.next = seq + 1;
    return new Response(Buffer.from(`${key}#${seq}`), { headers: { 'content-type': 'video/mp4' } });
  };
  return { fetch, calls, tracks };
}

const session = { sid: 'S1', mediaURL: 'http://x/f.mkv', info: { container: 'matroska,webm' } };
const copy = { convertId: 'wp-S1-c-h264', query: new URLSearchParams(), mode: 'copy' };
const audio = { convertId: 'wp-S1-a0', query: new URLSearchParams(), mode: 'audio' };
const transcode = { convertId: 'wp-S1-t-1280', query: new URLSearchParams(), mode: 'transcode' };
const segs = (calls, id) => calls.filter((c) => c.id === id && c.rest.includes('segment')).map((c) => Number(/segment(\d+)/.exec(c.rest)[1]));

test('viewers apart on one converter: no canceled segment, and the one behind reads what the first fetched', async () => {
  const up = fakeStremio();
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 0, audio: 0 } });
  const read = async (from, n) => {
    const got = [];
    for (let s = from; s < from + n; s++) got.push((await relay.serve(session, audio, `audio0/segment${s}.m4s`)).body.toString());
    return got;
  };
  const ahead = await read(5, 6);
  const [a, b] = await Promise.all([read(11, 4), read(5, 6)]);
  assert.deepEqual(ahead, [5, 6, 7, 8, 9, 10].map((s) => `wp-S1-a0/audio0#${s}`));
  assert.equal(a.length + b.length, 10);
  // Segments 5..10 came from the relay's memory: the converter went 5 → 14 without a restart.
  assert.deepEqual(segs(up.calls, 'wp-S1-a0'), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(up.tracks.get('wp-S1-a0/audio0').seeks, 1, 'only the first segment started the converter');
  assert.equal(up.tracks.get('wp-S1-a0/audio0').cancels, 0);
});

test('two viewers wanting different places at once: served one after the other, never canceled', async () => {
  const up = fakeStremio();
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 0, audio: 0 } });
  const results = await Promise.all([3, 40, 4, 41].map((s) => relay.serve(session, audio, `audio0/segment${s}.m4s`)));
  assert.deepEqual(results.map((r) => r.body.toString().split('#')[1]), ['3', '40', '4', '41']);
  assert.equal(up.tracks.get('wp-S1-a0/audio0').cancels, 0);
});

test('the next segments are made ahead of a viewer, and kept for them', async () => {
  const up = fakeStremio();
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 2, audio: 3 } });
  await relay.serve(session, copy, 'video0/segment1.m4s');
  await tick(60);
  assert.deepEqual(segs(up.calls, 'wp-S1-c-h264'), [1, 2, 3]);
  const before = up.calls.length;
  const res = await relay.serve(session, copy, 'video0/segment2.m4s');
  assert.equal(res.body.toString(), 'wp-S1-c-h264/video0#2');
  assert.equal(res.type, 'video/mp4');
  await tick(60);
  // Read 2: one more ahead (4), no request for 2 itself.
  assert.deepEqual(segs(up.calls.slice(before), 'wp-S1-c-h264'), [4]);
});

test('a transcoded Matroska video restarts one segment early; a copy and a small jump do not', async () => {
  const up = fakeStremio();
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 0, audio: 0 } });
  await relay.serve(session, transcode, 'video0/segment30.m4s');
  assert.deepEqual(segs(up.calls, 'wp-S1-t-1280'), [29, 30]);
  await relay.serve(session, transcode, 'video0/segment33.m4s');
  assert.deepEqual(segs(up.calls, 'wp-S1-t-1280'), [29, 30, 31, 32, 33], 'two past the run: it goes on');
  await relay.serve(session, copy, 'video0/segment30.m4s');
  assert.deepEqual(segs(up.calls, 'wp-S1-c-h264'), [30]);
  const mp4 = { ...session, sid: 'S2', info: { container: 'mov,mp4,m4a,3gp,3g2,mj2' } };
  await relay.serve(mp4, { ...transcode, convertId: 'wp-S2-t-1280' }, 'video0/segment30.m4s');
  assert.deepEqual(segs(up.calls, 'wp-S2-t-1280'), [30]);
});

test('a converter Stremio destroyed is asked again under a new name', async () => {
  const destroyed = new Set(['wp-S1-a0']);
  const up = fakeStremio({ destroyed });
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 0, audio: 0 } });
  const res = await relay.serve(session, audio, 'audio0/segment1.m4s');
  assert.equal(res.body.toString(), 'wp-S1-a0r1/audio0#1');
  await relay.serve(session, audio, 'audio0/segment2.m4s');
  assert.deepEqual(up.calls.map((c) => c.id), ['wp-S1-a0', 'wp-S1-a0r1', 'wp-S1-a0r1']);
});

test('playlists are cleaned of the source link, fetched once, and forgotten with their film', async () => {
  const up = fakeStremio();
  const relay = new HlsRelay({ fetch: up.fetch });
  const [a, b] = await Promise.all([relay.serve(session, copy, 'video0.m3u8'), relay.serve(session, copy, 'video0.m3u8')]);
  assert.equal(a.type, 'application/vnd.apple.mpegurl');
  assert.ok(!a.body.toString().includes('secret'));
  assert.equal(a.body, b.body);
  assert.equal(up.calls.length, 1);
  relay.prune(new Set(['other']));
  await relay.serve(session, copy, 'video0.m3u8');
  assert.equal(up.calls.length, 2);
});

test('a converter is kept alive while its room plays the film', async () => {
  const up = fakeStremio();
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 0, audio: 0 } });
  await relay.serve(session, audio, 'audio0/segment1.m4s');
  up.calls.length = 0;
  relay.keepAlive((sid) => sid === 'S1');
  relay.keepAlive(() => false);
  await tick(5);
  assert.deepEqual(up.calls, [{ id: 'wp-S1-a0', rest: 'audio0.m3u8' }]);
});

test('a viewer that leaves stops waiting', async () => {
  const up = fakeStremio({ segmentMs: 30 });
  const relay = new HlsRelay({ fetch: up.fetch, ahead: { video: 0, audio: 0 } });
  const abort = new AbortController();
  const p = relay.serve(session, audio, 'audio0/segment7.m4s', abort.signal);
  abort.abort();
  await assert.rejects(p, (err) => err.status === 499);
});

test('an audio converter that lost its source (silence for good) is replaced; a silence in the film is served as is', async () => {
  // Converter "wp-S1-a0": sound up to segment 3, then ~2 KB of silence (its input was cut).
  // Any fresh converter (new id) has the sound back. "quiet" ids: the film itself is silent.
  const calls = [];
  const fetch = async (s, params, rest) => {
    calls.push(`${params.convertId}/${rest}`);
    const seq = Number(/segment(\d+)/.exec(rest)?.[1]);
    const cut = params.convertId === 'wp-S1-a0' && seq >= 4;
    const quiet = params.convertId.startsWith('wp-S2') && seq >= 2;
    return new Response(Buffer.alloc(cut || quiet ? 2000 : 130_000));
  };
  const relay = new HlsRelay({ fetch, ahead: { video: 0, audio: 0 } });
  for (let s = 1; s <= 3; s++) await relay.serve(session, audio, `audio0/segment${s}.m4s`);
  const got = await relay.serve(session, audio, 'audio0/segment4.m4s');
  assert.equal(got.body.length, 130_000);
  assert.equal(calls.at(-1), 'wp-S1-a0r1/audio0/segment4.m4s');
  // From then on, the fresh converter.
  await relay.serve(session, audio, 'audio0/segment5.m4s');
  assert.equal(calls.at(-1), 'wp-S1-a0r1/audio0/segment5.m4s');

  const quiet = { ...audio, convertId: 'wp-S2-a0' };
  for (let s = 1; s <= 5; s++) assert.ok((await relay.serve({ ...session, sid: 'S2' }, quiet, `audio0/segment${s}.m4s`)).body.length < SILENT_AUDIO_BYTES || s === 1);
  // One try at the first silent segment (it could have been a cut), then never again.
  assert.equal(calls.filter((c) => c.startsWith('wp-S2-a0r1/')).length, 4);
  assert.equal(calls.filter((c) => c === 'wp-S2-a0/audio0/segment2.m4s').length, 1);
});
