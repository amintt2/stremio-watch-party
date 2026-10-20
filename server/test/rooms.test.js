import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEHIND_S, LOAD_TIMEOUT_MS, POSITION_STALE_MS, Room } from '../src/rooms.js';

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const room = new Room('r', { now: clock.now });
  room.join({ uid: 'a', name: 'A' });
  room.join({ uid: 'b', name: 'B' });
  return { room, clock };
}

const media = { sid: 's', duration: 7200, title: 'Film' };

test('load waits for every member before running', () => {
  const { room, clock } = setup();
  room.load(media);
  assert.equal(room.running, false);
  assert.deepEqual(room.snapshot().waiting.sort(), ['a', 'b']);

  room.setBuffering('a', false);
  clock.advance(3000);
  assert.equal(room.currentPosition(), 0, 'still frozen while b loads');

  room.setBuffering('b', false);
  assert.equal(room.running, true);
  clock.advance(5000);
  assert.equal(room.currentPosition(), 5);
});

test('load barrier gives up after the timeout', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  clock.advance(LOAD_TIMEOUT_MS);
  assert.equal(room.tick(), true);
  assert.equal(room.running, true);
  assert.equal(room.currentPosition(), 0);
});

test('a stall mid-film holds nobody: the live goes on', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(60_000);
  assert.equal(room.setBuffering('b', true), false);
  clock.advance(4000);
  assert.equal(room.currentPosition(), 64);
  assert.equal(room.running, true);
});

test('how far behind the live each viewer is, in 5 s steps', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(60_000);
  assert.equal(room.setPosition('a', 59.5), false, 'at the live: nothing to say');
  assert.equal(room.setPosition('b', 48), true, '12 s behind');
  assert.equal(room.snapshot().members.find((m) => m.uid === 'b').behind, 10);
  assert.equal(room.snapshot().members.find((m) => m.uid === 'a').behind, undefined);
  clock.advance(500);
  assert.equal(room.setPosition('b', 49), false, 'throttled');
  clock.advance(5000);
  assert.equal(room.setPosition('b', 54), false, 'still 12 s behind');
  // Pause: everyone stops where they are, the gap stays.
  room.pause();
  clock.advance(30_000);
  assert.equal(room.setPosition('b', 54.5), false);
  room.play();
  // A seek brings everybody to the same point.
  const seekId = room.snapshot().seekId;
  room.seek(100);
  assert.equal(room.snapshot().seekId, seekId + 1);
  assert.equal(room.snapshot().members.find((m) => m.uid === 'b').behind, undefined);
});

test('the film stays on until the last viewer behind has finished it', () => {
  const { room, clock } = setup();
  room.load({ ...media, duration: 100, next: { videoId: 'x' } });
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(80_000);
  room.setPosition('b', 60);
  clock.advance(25_000);
  room.tick();
  assert.equal(room.ended, true);
  assert.equal(room.done, false, 'b still has ~15 s to watch');
  assert.equal(room.snapshot().autonext, null);
  clock.advance(20_000);
  room.setPosition('b', 99.5);
  room.tick();
  assert.equal(room.done, true);
  assert.ok(room.snapshot().autonext, 'next episode armed once b is done');
});

test('a viewer who stopped reporting no longer holds the end', () => {
  const { room, clock } = setup();
  room.load({ ...media, duration: 100 });
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(50_000);
  room.setPosition('b', 10);
  clock.advance(POSITION_STALE_MS + 60_000);
  assert.equal(room.ended, true);
  assert.equal(room.done, true);
  assert.ok(BEHIND_S > 0);
});

test('pause, seek and play keep a consistent position', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(10_000);
  room.pause();
  clock.advance(30_000);
  assert.equal(room.currentPosition(), 10);
  room.seek(3600);
  room.play();
  clock.advance(2000);
  assert.equal(room.currentPosition(), 3602);
});

test('seek is clamped to the media duration', () => {
  const { room } = setup();
  room.load(media);
  room.seek(-5);
  assert.equal(room.position, 0);
  room.seek(99_999);
  assert.equal(room.position, 7199);
  room.seek('nope');
  assert.equal(room.position, 0);
});

test('buffering reports while paused do not create waits', () => {
  const { room } = setup();
  room.load(media);
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  room.pause();
  assert.equal(room.setBuffering('a', true), false);
  assert.equal(room.snapshot().waiting.length, 0);
});

test('leaving removes the member from the wait list', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  clock.advance(1000);
  room.leave('b');
  assert.equal(room.running, true);
  assert.equal(room.currentPosition(), 0);
});

test('multiple connections of one user count once', () => {
  const { room } = setup();
  assert.equal(room.join({ uid: 'a', name: 'A' }), false);
  assert.equal(room.leave('a'), false);
  assert.equal(room.members.has('a'), true);
  assert.equal(room.leave('a'), true);
  assert.equal(room.members.has('a'), false);
});

test('ten viewers: playback starts once all ten are ready', () => {
  let t = 0;
  const room = new Room('big', { now: () => t });
  const uids = Array.from({ length: 10 }, (_, i) => `u${i}`);
  for (const uid of uids) room.join({ uid, name: uid });
  room.load(media);
  for (const uid of uids.slice(0, 9)) room.setBuffering(uid, false);
  assert.equal(room.running, false);
  room.setBuffering('u9', false);
  assert.equal(room.running, true);
  assert.equal(room.snapshot().members.length, 10);
});

test('a group does not wait the full time for its slowest device', async () => {
  const { STRAGGLER_WAIT_MS } = await import('../src/rooms.js');
  let t = 1_000_000;
  const room = new Room('r', { now: () => t });
  for (const uid of ['a', 'b', 'c', 'd', 'e', 'f']) room.join({ uid, name: uid.toUpperCase() });
  room.load(media);
  for (const uid of ['a', 'b', 'c']) room.setBuffering(uid, false);
  t += STRAGGLER_WAIT_MS + 1;
  room.tick();
  assert.equal(room.running, false, 'half ready: everyone still waits');
  room.setBuffering('d', false);
  t += STRAGGLER_WAIT_MS + 1;
  room.tick();
  assert.equal(room.running, true, 'most ready: the last two get 8 s, not 20');

  // Two people: still the full wait for the friend.
  const { room: duo, clock } = setup();
  duo.load(media);
  duo.setBuffering('a', false);
  clock.advance(STRAGGLER_WAIT_MS + 1);
  duo.tick();
  assert.equal(duo.running, false);
});

test('a personal room stays its owner\'s, even when a guest opened it first', async () => {
  const { Rooms } = await import('../src/rooms.js');
  const rooms = new Rooms({ now: () => 1_000_000 });
  // The guest arrives first (after a restart): the room is created without an owner.
  const room = rooms.get('web:abc', { lobby: true, owner: null });
  room.join({ uid: 'guest', name: 'Guest' });
  assert.equal(room.host, 'guest');
  // The owner comes: recognised, straight in, crowned; the guest can't kick them.
  const again = rooms.get('web:abc', { lobby: true, owner: 'owner' });
  again.join({ uid: 'owner', name: 'Owner' });
  assert.equal(again.status('owner'), 'member');
  assert.equal(again.host, 'owner');
  assert.equal(again.kick('guest', 'owner'), false);
});

test('a viewer stuck in place does not hold the end of the film', () => {
  const { room, clock } = setup();
  room.load({ ...media, duration: 100, next: { videoId: 'x' } });
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(10_000);
  // b's player is in error: it keeps saying the same position.
  for (let i = 0; i < 30; i++) {
    room.setPosition('b', 5);
    clock.advance(5000);
  }
  room.tick();
  assert.equal(room.ended, true);
  assert.equal(room.done, true, 'b stuck for over a minute no longer counts');
});

test('a next episode that fails to start is not retried every 10 s', () => {
  const { room, clock } = setup();
  room.load({ ...media, duration: 100, next: { videoId: 'x', subtitle: 'S1E2' } });
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(101_000);
  room.tick();
  assert.ok(room.snapshot().autonext, 'armed');
  clock.advance(11_000);
  room.tick();
  const start = room.outbox.find((o) => o.type === 'start');
  assert.ok(start, 'next episode started');
  room.failStart(start.token);
  clock.advance(30_000);
  room.tick();
  assert.equal(room.snapshot().autonext, null, 'not armed again');
});

test('a start lost on the way is given up', () => {
  const { room, clock } = setup();
  room.beginStart({ title: 'Film' });
  clock.advance(5 * 60_000);
  room.tick();
  assert.equal(room.snapshot().starting, null);
});
