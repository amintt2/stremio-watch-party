import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/rooms.js';
import { RateLimiter, cleanProposal, handleRoomMessage } from '../src/roomSocket.js';

function room() {
  const r = new Room('r');
  r.join({ uid: 'a', name: 'A' });
  r.join({ uid: 'b', name: 'B' });
  r.load({ sid: 's', duration: 100, title: 'Film' }, { by: 'a' });
  r.setBuffering('a', false);
  r.setBuffering('b', false);
  return r;
}

test('invalid messages are ignored', () => {
  const r = room();
  for (const msg of [
    null,
    {},
    { t: 'nope' },
    { t: 'seek', position: 'x' },
    { t: 'seek', position: -1 },
    { t: 'seek', position: Infinity },
    { t: 'vote', id: '../../x' },
    { t: 'vote', id: 'a'.repeat(50) },
    { t: 'vote', id: 42 },
    { t: 'cancel', what: 'everything' },
    { t: 'mode', value: 'dictator' },
    { t: 'host', uid: { $ne: 1 } },
    { t: 'request', kind: 'stop' },
    { t: 'request', kind: 'seek' },
    { t: 'voteAction', kind: 'stop' },
    { t: 'presence', value: 'x'.repeat(1000) },
    { t: 'quality', value: 7 },
  ]) {
    assert.equal(handleRoomMessage(r, 'b', msg), false, JSON.stringify(msg));
  }
});

test('valid messages reach the room with the sender as actor', () => {
  const r = room();
  assert.equal(handleRoomMessage(r, 'b', { t: 'pause' }), true);
  assert.equal(r.paused, true);
  assert.equal(handleRoomMessage(r, 'b', { t: 'mode', value: 'host' }), true);
  assert.equal(handleRoomMessage(r, 'b', { t: 'play' }), true, 'becomes a request');
  assert.equal(r.paused, true);
  const [req] = r.snapshot().requests;
  assert.equal(handleRoomMessage(r, 'b', { t: 'respond', id: req.id, accept: true }), false, 'b is not the host');
  assert.equal(handleRoomMessage(r, 'a', { t: 'respond', id: req.id, accept: true }), true);
  assert.equal(r.paused, false);
  assert.equal(handleRoomMessage(r, 'a', { t: 'host', uid: 'b' }), true);
  assert.equal(r.host, 'b');
});

test('rate limiter: max hits per window, per key', () => {
  let t = 0;
  const rl = new RateLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  assert.equal(rl.allow('b'), true);
  t += 1000;
  assert.equal(rl.allow('a'), true);
});

test('proposal bodies are validated and trimmed', () => {
  assert.equal(cleanProposal(null), null);
  assert.equal(cleanProposal({ meta: { id: 'tt1', type: 'game' }, title: 'x' }), null);
  assert.equal(cleanProposal({ meta: { id: 'tt1', type: 'movie' } }), null, 'title required');
  const p = cleanProposal({
    meta: { id: 'tt1', type: 'series', videoId: 'tt1:1:2' },
    title: 'T'.repeat(500),
    subtitle: 'S1E02 · X',
    poster: 'javascript:alert(1)',
    streamKey: 'abc',
  });
  assert.equal(p.title.length, 200);
  assert.equal(p.poster, null);
  assert.deepEqual(p.meta, { id: 'tt1', type: 'series', videoId: 'tt1:1:2' });
  assert.equal(p.streamKey, 'abc');
});
