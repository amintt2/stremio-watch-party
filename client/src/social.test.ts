import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomState } from './api.ts';
import { canControl, canStart, isModerator, majorityNeeded, votesNeeded, memberStateLabel, parseTime, presentVotes, secondsLeft } from './social.ts';

const state = (o: Partial<RoomState>): RoomState => ({
  rev: 1,
  serverTime: 0,
  media: null,
  paused: false,
  running: true,
  position: 0,
  waiting: [],
  members: [],
  ...o,
});

test('strict majority', () => {
  assert.equal(majorityNeeded(1), 1);
  assert.equal(majorityNeeded(2), 2);
  assert.equal(majorityNeeded(3), 2);
  assert.equal(majorityNeeded(4), 3);
});

test('only present voters count', () => {
  assert.equal(presentVotes(['a', 'gone'], [{ uid: 'a' }, { uid: 'b' }]), 1);
});

test('control rights mirror the server', () => {
  const media = { sid: 's' } as RoomState['media'];
  assert.equal(canControl(state({ control: 'all' }), 'b'), true);
  assert.equal(canControl(state({ control: 'host', host: 'a' }), 'b'), false);
  assert.equal(canControl(state({ control: 'host', host: 'a', copilots: ['b'] }), 'b'), true, 'co-pilote');
  assert.equal(canControl(state({ control: 'host', host: 'a' }), 'a'), true);
  assert.equal(canStart(state({ control: 'host', host: 'a', media, ended: true }), 'b'), false, 'idle gives no remote');
  assert.equal(isModerator(state({ host: 'a', copilots: ['c'] }), 'c'), true);
  assert.equal(canControl(null, 'a'), false);
});

test('votes: strict majority, at least 2', () => {
  assert.equal(votesNeeded(1), 2);
  assert.equal(votesNeeded(2), 2);
  assert.equal(votesNeeded(3), 2);
  assert.equal(votesNeeded(4), 3);
});

test('labels and times', () => {
  assert.equal(memberStateLabel({ state: 'browsing' }), 'parcourt le catalogue');
  assert.equal(memberStateLabel({ state: 'loading' }), 'en chargement');
  assert.equal(parseTime('42:10'), 2530);
  assert.equal(parseTime('1:02:05'), 3725);
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime('1:2:3:4'), null);
  assert.equal(secondsLeft(10_500, 1_000), 10);
  assert.equal(secondsLeft(0, 1_000), 0);
});
