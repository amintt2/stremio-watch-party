import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoQuality } from './abr.ts';

// Every switch reloads the stream (a cut in sound and picture): these say when not to.
const ladder = ['2160', '1080', '720', '480'];
const MB = 1_000_000;
const slowish = { bytes: 4 * MB, loadMs: 3800, durationS: 4 }; // ratio ≈ 1.05: keeps up, barely
const draining = { bytes: 4 * MB, loadMs: 5000, durationS: 4 }; // ratio 0.8: the buffer empties
const fast = { bytes: 2 * MB, loadMs: 400, durationS: 4 }; // ratio 10

test('a slow download with a full buffer does not reload the stream', () => {
  const abr = new AutoQuality(ladder, '1080', 0);
  for (let i = 0; i < 20; i++) assert.equal(abr.onFragment(slowish, 10_000 + i * 4000, { ahead: 25 }), null);
  assert.equal(abr.current, '1080');
});

test('a slow download with a thin buffer still goes down', () => {
  const abr = new AutoQuality(ladder, '1080', 0);
  let next: string | null = null;
  for (let i = 0; i < 4 && !next; i++) next = abr.onFragment(slowish, 10_000 + i * 4000, { ahead: 4 });
  assert.equal(next, '720');
});

test('a full buffer that drains within a minute goes down before it empties', () => {
  const abr = new AutoQuality(ladder, '1080', 0);
  let next: string | null = null;
  // 0.8×: 10 s of buffer last 50 s, 30 s last 150 s.
  for (let i = 0; i < 6 && !next; i++) next = abr.onFragment(draining, 10_000 + i * 4000, { ahead: 30 });
  assert.equal(next, null);
  for (let i = 0; i < 6 && !next; i++) next = abr.onFragment(draining, 40_000 + i * 4000, { ahead: 11 });
  assert.equal(next, '720');
});

test('going up waits for a break while the film plays', () => {
  const abr = new AutoQuality(ladder, '720', 0);
  for (let i = 0; i < 20; i++) assert.equal(abr.onFragment(fast, 50_000 + i * 4000, { upNow: false }), null);
  assert.equal(abr.current, '720');
  assert.ok(abr.upPending);
  assert.equal(abr.atBreak(200_000), '1080');
  assert.equal(abr.upPending, false);
  assert.equal(abr.atBreak(201_000), null, 'once');
});

test('a switch up kept for a break is dropped when the speed falls or a stall comes', () => {
  const a = new AutoQuality(ladder, '720', 0);
  for (let i = 0; i < 20; i++) a.onFragment(fast, 50_000 + i * 4000, { upNow: false });
  // Ratio 1.3 for a while: fine to stay, no longer enough to go up.
  for (let i = 0; i < 8; i++) a.onFragment({ bytes: 2 * MB, loadMs: 3000, durationS: 4 }, 140_000 + i * 4000, { upNow: false, ahead: 30 });
  assert.equal(a.atBreak(150_000), null);

  const b = new AutoQuality(ladder, '720', 0);
  for (let i = 0; i < 20; i++) b.onFragment(fast, 50_000 + i * 4000, { upNow: false });
  b.onStall(150_000);
  assert.equal(b.atBreak(151_000), null);
});

test('a quality that did not hold is tried again less and less often', () => {
  const abr = new AutoQuality(ladder, '720', 0);
  const upAfter = (from: number) => {
    for (let t = from; t < from + 30 * 60_000; t += 4000) {
      if (abr.onFragment(fast, t, { upNow: true })) return t - from;
    }
    return Infinity;
  };
  const goDown = (at: number) => {
    for (let i = 0; i < 4; i++) {
      if (abr.onFragment(draining, at + i * 4000, { ahead: 2 })) {
        assert.equal(abr.current, '720');
        return at + i * 4000;
      }
    }
    throw new Error('did not go down');
  };
  // First climb after ~45 s; it fails within the flap window each time: the wait doubles.
  const first = upAfter(0);
  let t = goDown(first + 9000);
  const second = upAfter(t);
  t = goDown(t + second + 9000);
  const third = upAfter(t);
  assert.ok(first < 60_000, `first ${first}`);
  assert.ok(second >= 90_000 && second < 100_000, `second ${second}`);
  assert.ok(third >= 180_000 && third < 190_000, `third ${third}`);
});
