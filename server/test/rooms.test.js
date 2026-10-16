import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOAD_TIMEOUT_MS, Room, WAIT_TIMEOUT_MS } from '../src/rooms.js';

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

test('a stall freezes the room at the stall position, then resumes from there', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  clock.advance(60_000);
  room.setBuffering('b', true);
  clock.advance(4000);
  assert.equal(room.currentPosition(), 60);
  room.setBuffering('b', false);
  clock.advance(1000);
  assert.equal(room.currentPosition(), 61);
});

test('stalled viewers are dropped after WAIT_TIMEOUT_MS', () => {
  const { room, clock } = setup();
  room.load(media);
  room.setBuffering('a', false);
  room.setBuffering('b', false);
  room.setBuffering('b', true);
  clock.advance(WAIT_TIMEOUT_MS - 1);
  assert.equal(room.tick(), false);
  clock.advance(1);
  assert.equal(room.tick(), true);
  assert.equal(room.running, true);
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
