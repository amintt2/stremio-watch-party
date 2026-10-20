import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prewarms } from '../src/prewarm.js';

function setup() {
  let t = 0;
  const calls = { race: 0, open: [] };
  const prewarms = new Prewarms({
    now: () => t,
    race: async (keys) => {
      calls.race++;
      return { streams: keys.map((k) => ({ key: k })), pick: { label: keys[0] } };
    },
    open: async (stream) => {
      calls.open.push(stream.key);
      return { sid: `session-${stream.key}` };
    },
  });
  return { prewarms, calls, tick: (ms) => (t += ms) };
}

test('the page prepares, "Lire" finds the race won and the winner open', async () => {
  const { prewarms, calls } = setup();
  prewarms.start(['b', 'a'], { want: 'fr' });
  prewarms.start(['a', 'b'], { want: 'fr' }); // same sources: no second race
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.race, 1);
  assert.deepEqual(calls.open, ['b'], 'the winner is opened before anyone clicks');

  const got = prewarms.take(['a', 'b'], { want: 'fr' });
  assert.equal(got.reused, true);
  assert.deepEqual((await got.result).pick, { label: 'b' });
  assert.deepEqual(await got.opened, { sid: 'session-b' });
  assert.equal(calls.race, 1, 'nothing raced again');

  // Consumed: the next start of the same sources races again.
  const again = prewarms.take(['a', 'b'], { want: 'fr' });
  assert.equal(again.reused, false);
  await again.opened;
  assert.equal(calls.race, 2);
});

test('another language or an old preparation is not reused', async () => {
  const { prewarms, calls, tick } = setup();
  prewarms.start(['a'], { want: 'fr' });
  assert.equal(prewarms.take(['a'], { want: 'vo' }).reused, false);
  prewarms.start(['x'], { want: null });
  tick(4 * 60_000);
  assert.equal(prewarms.take(['x'], { want: null }).reused, false, 'expired after 3 min');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.race, 4);
});

test('a failing race or open stays quiet until someone asks', async () => {
  const prewarms = new Prewarms({ race: async () => { throw new Error('addon down'); }, open: async () => ({}) });
  prewarms.start(['a'], {});
  await new Promise((r) => setImmediate(r));
  const got = prewarms.take(['a'], {});
  await assert.rejects(got.result, /addon down/);
  await assert.rejects(got.opened, /addon down/);
});
