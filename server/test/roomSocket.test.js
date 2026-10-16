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
    { t: 'kick', uid: 'a b' },
    { t: 'copilot', uid: 'a', value: 'true' },
    { t: 'admit', uid: '' },
    { t: 'request', kind: 'start' },
  ]) {
    assert.equal(handleRoomMessage(r, 'b', msg), false, JSON.stringify(msg));
  }
});

test('valid messages reach the room with the sender as actor', () => {
  const r = room();
  r.join({ uid: 'c', name: 'C' });
  assert.equal(handleRoomMessage(r, 'b', { t: 'play' }), false, 'already playing');
  assert.equal(handleRoomMessage(r, 'b', { t: 'pause' }), true, 'protected: becomes a request');
  assert.equal(r.paused, false);
  const [req] = r.snapshot().requests;
  assert.equal(handleRoomMessage(r, 'b', { t: 'respond', id: req.id, accept: true }), false, 'b is not a moderator');
  assert.equal(handleRoomMessage(r, 'a', { t: 'respond', id: req.id, accept: true }), true);
  assert.equal(r.paused, true);
  assert.equal(handleRoomMessage(r, 'a', { t: 'copilot', uid: 'b', value: true }), true);
  assert.equal(handleRoomMessage(r, 'b', { t: 'play' }), true, 'co-pilote controls');
  assert.equal(r.paused, false);
  assert.equal(handleRoomMessage(r, 'b', { t: 'kick', uid: 'c' }), false, 'only the host kicks');
  assert.equal(handleRoomMessage(r, 'a', { t: 'kick', uid: 'c' }), true);
  assert.equal(r.status('c'), 'blocked');
  assert.equal(handleRoomMessage(r, 'a', { t: 'mode', value: 'all' }), true);
  assert.equal(handleRoomMessage(r, 'a', { t: 'host', uid: 'b' }), true);
  assert.equal(r.host, 'b');
  assert.equal(handleRoomMessage(r, 'b', { t: 'autoAdmit', value: 'yes' }), false);
  assert.equal(handleRoomMessage(r, 'b', { t: 'request', kind: 'start', id: '../x' }), false);
});

test('fuzz: two trolls in a room of four cannot change the film, the roles or the mode', () => {
  let t = 1_000_000;
  const r = new Room('fuzz', { now: () => t });
  for (const uid of ['a', 'b', 'c', 'd']) r.join({ uid, name: uid });
  r.load({ sid: 's', duration: 3600, title: 'Film' });
  for (const uid of ['a', 'b', 'c', 'd']) r.setBuffering(uid, false);
  r.setCopilot('a', 'b', true);
  let seed = 42;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  const pick = (list) => list[rnd(list.length)];
  const kinds = ['play', 'pause', 'seek', 'buffering', 'quality', 'presence', 'vote', 'withdraw', 'start', 'cancel', 'mode', 'host', 'request', 'respond', 'cancelRequest', 'voteAction', 'admit', 'refuse', 'autoAdmit', 'kick', 'copilot', 'stop', '__proto__', null];
  const values = [undefined, null, true, false, 0, -1, 1e9, NaN, 'a', 'b', 'c', 'd', '1', '2', 'all', 'host', 'pause', 'skip', 'seek', 'start', 'autostart', 'autonext', {}, [], 'x'.repeat(300)];
  for (let i = 0; i < 5000; i++) {
    const msg = { t: pick(kinds), id: pick(values), uid: pick(values), value: pick(values), kind: pick(values), position: pick(values), what: pick(values), accept: pick(values) };
    handleRoomMessage(r, pick(['c', 'd', 'zz']), msg);
    if (i % 50 === 0) {
      t += 1000;
      r.tick();
    }
    r.drain();
  }
  assert.equal(r.media.sid, 's');
  assert.equal(r.host, 'a');
  assert.equal(r.control, 'host');
  assert.deepEqual([...r.copilots], ['b']);
  assert.equal(r.paused, false);
  assert.ok(Number.isFinite(r.currentPosition()));
  assert.equal(r.members.size, 4);
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
