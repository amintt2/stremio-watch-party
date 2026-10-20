import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedPosition, formatTime, joinLiveJump, loadRetryWait, ServerClock } from './sync.ts';
import { AutoQuality } from './abr.ts';

test('server clock prefers low-latency samples', () => {
  const c = new ServerClock();
  c.add(1000, 6050, 1100); // rtt 100, offset 5000
  c.add(2000, 8000, 3000); // rtt 1000, offset 5500 (noisy)
  c.add(4000, 9010, 4020); // rtt 20, offset 5000
  c.add(5000, 10_005, 5010); // rtt 10, offset 5000
  assert.equal(Math.round(c.offset), 5000);
});

test('expected position extrapolates only while running', () => {
  const t = { running: true, position: 10, serverTime: 1000, duration: 100 };
  assert.equal(expectedPosition(t, 3000), 12);
  assert.equal(expectedPosition({ ...t, running: false }, 3000), 10);
  assert.equal(expectedPosition(t, 1_000_000), 100);
});

test('time formatting', () => {
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(754), '12:34');
  assert.equal(formatTime(7322), '2:02:02');
});

const ladder = ['2160', '1080', '720', '480'];
const MB = 1_000_000;

test('auto quality goes down when download is slower than playback', () => {
  const abr = new AutoQuality(ladder, '1080', 0);
  let next: string | null = null;
  // 4 s fragments of 4 MB (8 Mb/s) taking 3.8 s to load → ratio ≈ 1.05
  for (let i = 0; i < 4 && !next; i++) next = abr.onFragment({ bytes: 4 * MB, loadMs: 3800, durationS: 4 }, 10_000 + i * 4000);
  assert.equal(next, '720');
});

test('auto quality goes up only after a sustained fast period', () => {
  const abr = new AutoQuality(ladder, '720', 0);
  const fast = { bytes: 2 * MB, loadMs: 400, durationS: 4 }; // ratio 10
  assert.equal(abr.onFragment(fast, 5000), null);
  let next: string | null = null;
  for (let i = 0; i < 10 && !next; i++) next = abr.onFragment(fast, 50_000 + i * 4000);
  assert.equal(next, '1080');
});

test('two stalls in a minute force a step down', () => {
  const abr = new AutoQuality(ladder, '2160', 0);
  assert.equal(abr.onStall(20_000), null);
  assert.equal(abr.onStall(40_000), '1080');
});

test('never goes above the top or below the bottom of the ladder', () => {
  const top = new AutoQuality(ladder, '2160', 0);
  for (let i = 0; i < 20; i++) top.onFragment({ bytes: MB, loadMs: 10, durationS: 4 }, 100_000 + i * 50_000);
  assert.equal(top.current, '2160');
  const bottom = new AutoQuality(ladder, '480', 0);
  assert.equal(bottom.onStall(20_000), null);
  assert.equal(bottom.onStall(30_000), null);
  assert.equal(bottom.current, '480');
});

test('arriving mid-film: jump to the live only when it costs no second wait, or when far', () => {
  assert.equal(joinLiveJump(1, false, 4), false, 'close enough');
  assert.equal(joinLiveJump(3, true, 4), true, 'already loaded there: free');
  assert.equal(joinLiveJump(3, false, 4), false, 'would load again for 3 s');
  assert.equal(joinLiveJump(14, false, 4), true, 'far behind: worth the wait');
});

test('reloads of a stream that shows nothing come less and less often', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => loadRetryWait(n) / 1000), [30, 60, 120, 240, 240, 240]);
});
