import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferedAhead, bufferHealth, catchUpTarget, ewma, fragmentRatio, lowerQuality, sourceDetail, sourceProblem, speedLabel } from './health.ts';

test('buffer health: buffer ahead + throughput vs bitrate', () => {
  assert.equal(bufferHealth({ ahead: 40, ratio: 3, left: 3000 }), 'good');
  assert.equal(bufferHealth({ ahead: 40, ratio: null, left: 3000 }), 'good', 'no sample yet: buffer only');
  assert.equal(bufferHealth({ ahead: 6, ratio: 3, left: 3000 }), 'fair', 'thin buffer');
  assert.equal(bufferHealth({ ahead: 20, ratio: 1.1, left: 3000 }), 'fair', 'barely real time');
  assert.equal(bufferHealth({ ahead: 1.5, ratio: 3, left: 3000 }), 'poor', 'almost empty');
  assert.equal(bufferHealth({ ahead: 12, ratio: 0.7, left: 3000 }), 'poor', 'slower than real time');
  assert.equal(bufferHealth({ ahead: 25, ratio: 0.7, left: 3000 }), 'fair', 'slow but big buffer');
  assert.equal(bufferHealth({ ahead: 2, ratio: 3, left: 2.2 }), 'good', 'end of the film: nothing more to buffer');
});

test('segment ratio and smoothing', () => {
  // 1 MB of 4 s media downloaded in 1 s: 4× real time.
  assert.equal(fragmentRatio(1_000_000, 1000, 4), 4);
  assert.equal(fragmentRatio(5_000, 1000, 4), null, 'too small to measure');
  assert.equal(fragmentRatio(1_000_000, 0, 4), null);
  assert.equal(ewma(null, 2), 2);
  assert.equal(ewma(2, 1, 0.5), 1.5);
});

test('buffered ahead and lower quality', () => {
  const ranges: [number, number][] = [
    [0, 30],
    [60, 90],
  ];
  assert.equal(bufferedAhead(ranges, 10), 20);
  assert.equal(bufferedAhead(ranges, 45), 0);
  assert.equal(bufferedAhead(ranges, 59.9), 30.1, 'just before a range');
  assert.equal(lowerQuality(['1080', '720', '480'], '1080'), '720');
  assert.equal(lowerQuality(['1080', '720', '480'], '480'), null);
  assert.equal(lowerQuality(['1080', '720'], null), null);
});

test('catch-up: exact inside the buffer, ahead of the room outside', () => {
  const ranges: [number, number][] = [[0, 30]];
  assert.deepEqual(catchUpTarget(20, ranges, 2), { position: 20, lead: 0 });
  assert.deepEqual(catchUpTarget(40, ranges, 2), { position: 42, lead: 2 });
  assert.deepEqual(catchUpTarget(40, ranges, 0.2), { position: 41, lead: 1 }, 'at least 1 s');
  assert.deepEqual(catchUpTarget(40, ranges, 30), { position: 44, lead: 4 }, 'at most 4 s');
  assert.deepEqual(catchUpTarget(29.8, ranges, 2), { position: 31.8, lead: 2 }, 'buffer ends right there');
});

test('torrent source health: details and who is to blame', () => {
  const ok = { kind: 'torrent' as const, level: 'ok' as const, peers: 12, downloadSpeed: 3_100_000 };
  assert.equal(sourceDetail(ok), 'Torrent : 12 pairs · 3,1 Mo/s');
  assert.equal(sourceDetail({ kind: 'torrent', level: 'slow', peers: 1, downloadSpeed: 400_000 }), 'Torrent : 1 pair · 400 Ko/s');
  assert.equal(sourceDetail({ kind: 'torrent', level: 'done' }), 'Torrent : fichier complet sur le serveur');
  assert.equal(sourceDetail({ kind: 'http' }), '');
  assert.equal(sourceDetail(null), '');

  const slow = { kind: 'torrent' as const, level: 'slow' as const, peers: 1, downloadSpeed: 4e5 };
  assert.match(sourceProblem(slow, 'poor') || '', /pour tout le monde/);
  assert.equal(sourceProblem(slow, 'good'), null, 'buffer fine: nothing to say');
  assert.match(sourceProblem({ kind: 'torrent', level: 'stalled' }, 'fair') || '', /plus de pairs/);
  assert.equal(sourceProblem(ok, 'poor'), null, 'source fine: it is the viewer connection');
  assert.equal(sourceProblem({ kind: 'http' }, 'poor'), null);
  assert.match(sourceProblem(slow, null, true) || '', /pour tout le monde/, 'stuck with no buffer reading');
  assert.equal(sourceProblem(slow, null, false), null);
  assert.equal(speedLabel(52_000), '52 Ko/s');
  assert.equal(speedLabel(3_100_000), '3,1 Mo/s');
});
