import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EncoderHub,
  SegmentCache,
  cleanHello,
  keyMatches,
  masterPlaylist,
  mediaPlaylist,
  newKey,
  parseGpuPath,
  parseKey,
  renditionSize,
  segmentCount,
} from '../src/encoder.js';
import { withTrailer, zipFiles } from '../src/encoderRoutes.js';

const info = {
  duration: 10.5,
  video: { codec: 'hevc', width: 3840, height: 1600, fps: 23.976 },
  audio: [{ language: 'fre', title: 'Français' }, { language: 'eng', title: null }],
};

test('pairing keys: only the hash is kept, the secret is checked in constant time', () => {
  const k = newKey();
  const parsed = parseKey(k.token);
  assert.equal(parsed.id, k.id);
  assert.ok(keyMatches(parsed.secret, k.hash));
  assert.ok(!keyMatches(parsed.secret.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), k.hash));
  assert.equal(parseKey('wpe_nope'), null);
  assert.equal(parseKey(null), null);
});

test('playlists on the fixed 4 s grid, master with every audio track', () => {
  assert.equal(segmentCount(10.5), 3);
  const media = mediaPlaylist(10.5, 'gv');
  assert.match(media, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.deepEqual(media.match(/gv\/\d+\.ts/g), ['gv/0.ts', 'gv/1.ts', 'gv/2.ts']);
  assert.match(media, /#EXTINF:2\.500,\ngv\/2\.ts/);
  assert.match(media, /#EXT-X-ENDLIST/);

  assert.deepEqual(renditionSize('1080', info.video), { width: 2592, height: 1080, bitrate: 6_000_000 });
  assert.deepEqual(renditionSize('2160', { width: 1920, height: 1080 }).height, 1080, 'never above the source');
  const master = masterPlaylist('1080', info);
  assert.match(master, /NAME="Français",LANGUAGE="fre",DEFAULT=YES.*URI="gaudio0\.m3u8"/);
  assert.match(master, /NAME="eng",LANGUAGE="eng",DEFAULT=NO.*URI="gaudio1\.m3u8"/);
  assert.match(master, /RESOLUTION=2592x1080,CODECS="avc1\.640028,mp4a\.40\.2",AUDIO="aud"\ngvideo\.m3u8/);
});

test('only encoder paths are accepted', () => {
  assert.deepEqual(parseGpuPath('gvideo.m3u8'), { kind: 'playlist', rendition: 'v' });
  assert.deepEqual(parseGpuPath('gaudio1.m3u8'), { kind: 'playlist', rendition: 'a1' });
  assert.deepEqual(parseGpuPath('gv/12.ts'), { kind: 'segment', rendition: 'v', index: 12 });
  assert.deepEqual(parseGpuPath('ga0/3.ts'), { kind: 'segment', rendition: 'a0', index: 3 });
  for (const bad of ['gv/../x.ts', 'gv/1.m4s', 'gaudio.m3u8', 'master.m3u8', 'gv/1234567.ts']) assert.equal(parseGpuPath(bad), null, bad);
});

test('the app describes itself, checked', () => {
  assert.deepEqual(cleanHello({ version: 'v1', os: 'windows', encoder: 'NVIDIA NVENC', device: 'RTX\u0000 3070', maxHeight: 9999 }), {
    version: 'v1',
    os: 'windows',
    encoder: 'NVIDIA NVENC',
    device: 'RTX 3070',
    maxHeight: 1080,
  });
});

test('segment cache stays under its size, least recently used out first', () => {
  const c = new SegmentCache(10);
  c.set('a', Buffer.alloc(4));
  c.set('b', Buffer.alloc(4));
  c.get('a');
  c.set('c', Buffer.alloc(4));
  assert.ok(c.has('a') && c.has('c') && !c.has('b'));
  assert.equal(c.bytes, 8);
  c.dropPrefix('a');
  assert.equal(c.bytes, 4);
});

function setup() {
  const sent = [];
  const changes = [];
  const key = newKey();
  const hub = new EncoderHub({
    keys: (id) => (id === key.id ? { uid: 'alice', hash: key.hash, label: 'PC' } : null),
    onChange: (sid) => changes.push(sid),
    cacheBytes: 1e6,
  });
  const auth = hub.authenticate(key.token);
  const agent = hub.connect(auth, (m) => sent.push(m), () => {});
  hub.message(agent, { type: 'hello', version: '1', os: 'linux', encoder: 'NVENC', maxHeight: 2160 });
  const session = { sid: 's1', info: { ...info, duration: 400 } };
  return { hub, agent, sent, changes, session, key };
}

test('a film goes to an online encoder, segments are asked for, encoded ahead, then served', async () => {
  const { hub, agent, sent, changes, session } = setup();
  assert.equal(hub.authenticate('wpe_000000000000.' + 'x'.repeat(32)), null);
  assert.equal(hub.attach(session, ['bob', 'alice']).agent, agent, 'first candidate with an encoder');
  assert.deepEqual(changes, ['s1']);
  assert.equal(sent[0].type, 'job');
  assert.equal(sent[0].job.source, `/api/encoder/source/${session.gpu.id}`);
  assert.deepEqual(hub.describe(session.gpu), { by: 'alice', encoder: 'NVENC', device: null });

  const job = session.gpu;
  const waiting = hub.segment(job, '1080', 'v', 10);
  const want = sent.at(-1);
  assert.equal(want.type, 'want');
  assert.equal(want.start, 10);
  assert.equal(want.until, 30);
  assert.deepEqual(want.video, [{ id: '1080', width: 2592, height: 1080, bitrate: 6_000_000 }]);
  assert.equal(hub.upload('other-agent', job.id, 'v1080', 10, Buffer.from('x')), false, 'only from its own app');
  assert.ok(hub.upload(agent.id, job.id, 'v1080', 10, Buffer.from('ts10')));
  assert.equal(String(await waiting), 'ts10');

  // The next segments are on their way: no new run.
  const n = sent.length;
  const next = hub.segment(job, '1080', 'v', 11);
  assert.equal(sent.length, n);
  hub.upload(agent.id, job.id, 'v1080', 11, Buffer.from('ts11'));
  assert.equal(String(await next), 'ts11');

  // Viewers get close to the end of what was asked: extended.
  for (let i = 12; i <= 21; i++) hub.upload(agent.id, job.id, 'v1080', i, Buffer.from('t'));
  await hub.segment(job, '1080', 'v', 21);
  assert.deepEqual(sent.at(-1), { type: 'extend', job: job.id, until: 41 });

  // A seek far away: a new run from there; an audio track joins the run.
  const far = hub.segment(job, '1080', 'v', 80);
  assert.equal(sent.at(-1).type, 'want');
  assert.equal(sent.at(-1).start, 80);
  const audio = hub.segment(job, '1080', 'a1', 80);
  assert.deepEqual(sent.at(-1).audio, [1]);
  hub.upload(agent.id, job.id, 'v1080', 80, Buffer.from('v'));
  hub.upload(agent.id, job.id, 'a1', 80, Buffer.from('a'));
  await Promise.all([far, audio]);
  await assert.rejects(hub.segment(job, '1080', 'v', 9999), /hors du film/);
});

test('encoder gone: viewers waiting are released and the room falls back', async () => {
  const { hub, agent, changes, session } = setup();
  hub.attach(session, ['alice']);
  const waiting = hub.segment(session.gpu, '720', 'v', 0);
  hub.disconnect(agent);
  await assert.rejects(waiting, /déconnecté/);
  assert.equal(session.gpu, null);
  assert.deepEqual(changes, ['s1', 's1']);
  assert.equal(hub.status('alice').online, false);
});

test('download packaging: settings after the .exe, zip with the executable bit', () => {
  const exe = withTrailer(Buffer.from('MZprogram'), { server: 'https://w.example', key: 'wpe_x' });
  const m = /#WPCFG#([^#]+)#END#/.exec(exe.toString());
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64').toString()), { server: 'https://w.example', key: 'wpe_x' });
  assert.ok(exe.toString().startsWith('MZprogram'));

  const dir = mkdtempSync(join(tmpdir(), 'wp-zip-'));
  try {
    writeFileSync(join(dir, 'a.zip'), zipFiles([{ name: 'app', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 }, { name: 'cfg.json', data: Buffer.from('{}') }]));
    execFileSync('unzip', ['-q', join(dir, 'a.zip'), '-d', join(dir, 'out')]);
    assert.equal(readFileSync(join(dir, 'out', 'cfg.json'), 'utf8'), '{}');
    assert.equal(statSync(join(dir, 'out', 'app')).mode & 0o777, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing app gets the film back later, and the statistics say why', () => {
  let t = 1_000_000;
  const hub = new EncoderHub({ keys: () => null, now: () => t });
  const sent = [];
  const agent = hub.connect({ id: 'k1', uid: 'alice', label: 'PC' }, (m) => sent.push(m), () => {});
  hub.message(agent, { type: 'hello', version: '1', os: 'windows', encoder: 'NVENC', device: 'RTX 4070', maxHeight: 2160 });
  const session = { sid: 's1', info: { duration: 600, video: { width: 3840, height: 2160, codec: 'hevc' }, audio: [{}] } };
  const job = hub.attach(session, ['alice']);
  assert.ok(job);
  assert.equal(hub.state(session, ['alice']).status, 'ready');
  hub.served(job);
  assert.deepEqual(
    { status: hub.state(session, ['alice']).status, device: hub.state(session, ['alice']).device },
    { status: 'working', device: 'RTX 4070' }
  );

  // Three failures: taken back, told why, and not given back at once.
  hub.message(agent, { type: 'error', job: job.id, message: 'ffmpeg a quitté' });
  hub.message(agent, { type: 'error', job: job.id, message: 'ffmpeg a quitté' });
  hub.message(agent, { type: 'error', job: job.id, message: 'ffmpeg a quitté' });
  assert.equal(session.gpu, null);
  const stop = sent.find((m) => m.type === 'stop');
  assert.equal(stop.reason, 'ffmpeg a quitté');
  assert.equal(stop.retryIn, 60);
  assert.deepEqual(
    (({ status, error, retryIn }) => ({ status, error, retryIn }))(hub.state(session, ['alice'])),
    { status: 'retry', error: 'ffmpeg a quitté', retryIn: 60 }
  );
  assert.equal(hub.attach(session, ['alice']), null);
  t += 61_000;
  assert.ok(hub.attach(session, ['alice']), 'back to the app after the wait');
  assert.equal(hub.state({ sid: 'x', info: {} }, ['bob']), null, 'nobody with an app: nothing to show');
});
