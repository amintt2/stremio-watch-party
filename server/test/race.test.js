import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePeerRace, languageScore, raceHttp, raceTorrents, rankSources, shouldWiden, afterExhausted } from '../src/race.js';

const src = (key, o = {}) => ({ key, kind: 'torrent', cached: false, quality: '1080p', seeders: 10, languages: [], tooBig: false, ...o });

test('ranking: language, then instant links, then quality (1080p first), then seeders', () => {
  const list = [
    src('4k', { quality: '4K', seeders: 900 }),
    src('720-vf', { quality: '720p', languages: ['VF'] }),
    src('1080', { seeders: 50 }),
    src('1080-few', { seeders: 3 }),
    src('debrid', { kind: 'http', cached: true, quality: '720p' }),
    src('multi', { languages: ['MULTI'], quality: '480p' }),
    src('huge', { tooBig: true, languages: ['MULTI'] }),
  ];
  assert.deepEqual(rankSources(list).map((s) => s.key), ['multi', 'debrid', '1080', '1080-few', '720-vf', '4k']);
  assert.deepEqual(rankSources(list, 'fr').map((s) => s.key).slice(0, 2), ['720-vf', 'multi'], 'VF and MULTI both fit: quality decides');
  assert.equal(languageScore(['VF'], 'vo'), 1);
  assert.equal(languageScore(['VOSTFR'], 'vo'), 0);
  assert.equal(languageScore([], 'vo'), 0);
});

const probe = (state, connected = 0, o = {}) => ({ state, connected, peers: connected * 3, ...o });

test('race decision: first healthy swarm wins, a better language gets a short grace', () => {
  const c = (key, lang, p) => ({ key, lang, probe: p });
  assert.deepEqual(decidePeerRace([c('a', 0, probe('resolving')), c('b', 0, probe('healthy', 5, { doneAtMs: 300 }))], 400), { key: 'b', why: 'healthy' });
  // b is healthy but in the other language; a (wanted language) may still answer.
  assert.ok(decidePeerRace([c('a', 0, probe('resolving')), c('b', 1, probe('healthy', 5, { doneAtMs: 300 }))], 400).waitMs > 0);
  assert.equal(decidePeerRace([c('a', 0, probe('resolving')), c('b', 1, probe('healthy', 5, { doneAtMs: 300 }))], 900).key, 'b');
  // Soft deadline: nobody healthy, the one with answering peers.
  assert.deepEqual(decidePeerRace([c('a', 0, probe('resolving')), c('b', 0, probe('weak', 1)), c('d', 0, probe('weak', 2))], 2100), { key: 'd', why: 'best' });
  // Everything failed.
  assert.deepEqual(decidePeerRace([c('a', 0, probe('failed')), c('b', 0, probe('noFile', 4))], 500), { key: null, exhausted: true });
  assert.equal(shouldWiden([probe('resolving', 1)], 1100), true);
  assert.equal(shouldWiden([probe('resolving', 4)], 1100), false);
  assert.equal(afterExhausted([c('a', 0, probe('failed', 2)), c('b', 0, probe('noFile', 9))]), 'a');
});

test('torrent race through the engine: the healthy swarm wins even ranked last, probes are cancelled', async () => {
  let clock = 0;
  const started = [];
  const cancelled = [];
  // Ranked first two are dead swarms, the third answers fast.
  const timeline = { a: [[0, 'resolving', 0], [3000, 'failed', 0]], b: [[0, 'resolving', 0]], c: [[0, 'resolving', 0], [400, 'healthy', 6]] };
  const ids = {};
  const fake = {
    async start(req) {
      const key = req.infoHash[0];
      ids[started.length + 1] = key;
      started.push(req);
      return { id: started.length, state: 'queued', peers: 0, connected: 0 };
    },
    async statuses(list) {
      return list.map((id) => {
        const steps = timeline[ids[id]].filter(([t]) => t <= clock);
        const [, state, connected] = steps.at(-1);
        return { id, state, connected, peers: connected };
      });
    },
    async cancel(list) {
      cancelled.push(...list);
    },
  };
  const t = (k) => ({ key: k, lang: 0, stream: { infoHash: k.repeat(40), fileIdx: 1, behaviorHints: { filename: 'x.mkv' } } });
  const res = await raceTorrents([t('a'), t('b'), t('c')], fake, { now: () => clock, sleep: async (ms) => (clock += ms), episode: 3 });
  assert.equal(res.key, 'c');
  assert.equal(res.why, 'healthy');
  assert.equal(started.length, 3);
  assert.equal(started[0].fileIdx, 1);
  assert.equal(started[0].episode, 3);
  assert.ok(started[0].sources.length > 0, 'trackers sent');
  assert.ok(clock < 1000, `decided at ${clock} ms`);
  assert.deepEqual(cancelled.sort(), [1, 2, 3]);
});

test('direct links: the best-ranked one that answers', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://dead') throw new Error('refused');
    await new Promise((r) => setTimeout(r, url === 'https://slow' ? 80 : 5));
    return { status: url === 'https://404' ? 404 : 206, body: null };
  };
  const c = (key, url) => ({ key, stream: { url } });
  assert.equal((await raceHttp([c('a', 'https://dead'), c('b', 'https://ok')], { fetchImpl })).key, 'b');
  assert.equal((await raceHttp([c('a', 'https://slow'), c('b', 'https://ok')], { fetchImpl, graceMs: 200 })).key, 'a', 'better rank within the grace');
  assert.equal(await raceHttp([c('a', 'https://404')], { fetchImpl }), null);
});

test('one Huwa session for concurrent probes, kept on disk across restarts', async () => {
  const { HuwaProbes } = await import('../src/race.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'wp-huwa-'));
  let sessions = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/v1/session')) {
      sessions++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, status: 201, json: async () => ({ token: `t${sessions}` }) };
    }
    assert.equal(init.headers.Authorization, 'Bearer t1');
    return { ok: true, status: 200, json: async () => ({ id: 1, state: 'queued' }) };
  };
  try {
    const file = join(dir, 'huwa-session.json');
    const a = new HuwaProbes('http://huwa', { file, fetchImpl });
    await Promise.all([a.start({}), a.start({}), a.start({})]);
    assert.equal(sessions, 1);
    const b = new HuwaProbes('http://huwa', { file, fetchImpl });
    await b.start({});
    assert.equal(sessions, 1, 'restart reuses the saved session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
