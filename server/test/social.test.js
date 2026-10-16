import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_VOTE_TTL_MS,
  AUTONEXT_MS,
  AUTOSTART_MS,
  EMPTY_ROOM_TTL_MS,
  LOAD_TIMEOUT_MS,
  QUEUE_PER_USER_MAX,
  REQUEST_TTL_MS,
  Room,
  Rooms,
  formatTime,
  mediaLabel,
} from '../src/rooms.js';

function setup(uids = ['a', 'b', 'c']) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const room = new Room('r', { now: clock.now });
  for (const uid of uids) room.join({ uid, name: uid.toUpperCase() });
  room.drain();
  return { room, clock };
}

const media = (extra = {}) => ({ sid: 's1', duration: 3600, title: 'Film', subtitle: '', ...extra });

/** Loads and marks everyone ready. */
function playing(room, by = 'a', m = media()) {
  room.load(m, { by });
  for (const uid of room.members.keys()) room.setBuffering(uid, false);
  room.drain();
}

const notices = (room) => room.drain().filter((e) => e.type === 'notice');
const starts = (room) => room.drain().filter((e) => e.type === 'start');
const proposal = (videoId, extra = {}) => ({
  meta: { id: videoId.split(':')[0], type: 'movie', videoId },
  title: `Titre ${videoId}`,
  ...extra,
});

// ------------------------------------------------------------ continuity

test('the starter leaving does not stop the film for the others', () => {
  const { room, clock } = setup();
  playing(room, 'a');
  clock.advance(30_000);
  room.leave('a');
  assert.ok(room.media, 'media kept');
  assert.equal(room.running, true);
  clock.advance(10_000);
  assert.equal(room.currentPosition(), 40);
});

test('the starter being the only one still loading and leaving unblocks the room', () => {
  const { room, clock } = setup();
  room.load(media(), { by: 'a' });
  room.setBuffering('b', false);
  room.setBuffering('c', false);
  assert.equal(room.running, false);
  room.leave('a');
  assert.equal(room.running, true);
  clock.advance(2000);
  assert.equal(room.currentPosition(), 2);
});

test('the starter reconnecting keeps the room going', () => {
  const { room, clock } = setup();
  playing(room, 'a');
  clock.advance(5000);
  room.leave('a');
  room.join({ uid: 'a', name: 'A' });
  assert.equal(room.running, true, 'a rejoiner is not a load barrier');
  clock.advance(1000);
  assert.equal(room.currentPosition(), 6);
  assert.equal(room.media.sid, 's1');
});

test('last person leaving keeps the film paused; a quick rejoin resumes it', () => {
  const { room, clock } = setup(['a']);
  playing(room, 'a');
  clock.advance(42_000);
  room.leave('a');
  assert.equal(room.empty, true);
  assert.equal(room.paused, true);
  clock.advance(60_000);
  assert.equal(room.currentPosition(), 42, 'frozen while nobody is there');
  room.join({ uid: 'b', name: 'B' });
  assert.equal(room.paused, false);
  assert.deepEqual(room.snapshot().waiting, ['b'], 'waits for the newcomer to load');
  room.setBuffering('b', false);
  clock.advance(3000);
  assert.equal(room.currentPosition(), 45);
  assert.equal(room.host, 'b');
});

test('a paused film stays paused when the room is emptied and rejoined', () => {
  const { room } = setup(['a']);
  playing(room, 'a');
  room.pause();
  room.leave('a');
  room.join({ uid: 'a', name: 'A' });
  assert.equal(room.paused, true);
});

test('empty rooms are kept for a while, then swept', () => {
  let t = 0;
  const rooms = new Rooms({ now: () => t });
  const room = rooms.get('x');
  room.join({ uid: 'a', name: 'A' });
  room.load(media(), { by: 'a' });
  room.leave('a');
  t += EMPTY_ROOM_TTL_MS - 1;
  assert.deepEqual(rooms.sweep(), []);
  assert.equal(rooms.peek('x'), room);
  room.join({ uid: 'a', name: 'A' });
  t += EMPTY_ROOM_TTL_MS * 2;
  assert.deepEqual(rooms.sweep(), [], 'occupied rooms are never swept');
  room.leave('a');
  t += EMPTY_ROOM_TTL_MS;
  assert.deepEqual(rooms.sweep(), ['x']);
});

// ------------------------------------------------------------ host

test('host: first member, then whoever starts the media, then the longest present', () => {
  const { room } = setup();
  assert.equal(room.host, 'a');
  playing(room, 'b');
  assert.equal(room.host, 'b');
  room.leave('b');
  assert.equal(room.host, 'a', 'longest present (a joined before c)');
  room.join({ uid: 'b', name: 'B' });
  assert.equal(room.host, 'a', 'does not come back automatically');
});

test('host transfer is announced in host mode', () => {
  const { room } = setup();
  room.setControl('b', 'host');
  room.drain();
  room.leave('a');
  assert.equal(room.host, 'b');
  assert.match(notices(room)[0].text, /B est maintenant l’hôte/);
});

test('the host can hand over; nobody else can', () => {
  const { room } = setup();
  assert.equal(room.handOver('b', 'c'), false);
  assert.equal(room.handOver('a', 'zz'), false);
  assert.equal(room.handOver('a', 'c'), true);
  assert.equal(room.host, 'c');
});

test('anyone enables host mode, only the host ends it', () => {
  const { room } = setup();
  assert.equal(room.setControl('c', 'host'), true);
  assert.equal(room.control, 'host');
  assert.equal(room.host, 'a');
  assert.equal(room.setControl('c', 'all'), false);
  assert.equal(room.setControl('a', 'all'), true);
  assert.equal(room.setControl('a', 'bogus'), false);
});

test('host-only: others cannot play, pause, seek or start while it plays', () => {
  const { room } = setup();
  playing(room, 'a');
  room.setControl('a', 'host');
  assert.equal(room.canControl('a'), true);
  assert.equal(room.canControl('b'), false);
  assert.equal(room.canStart('b'), false);
  room.act('b', 'pause');
  assert.equal(room.paused, false, 'not applied');
  assert.equal(room.requests.size, 1, 'turned into a request');
  room.act('a', 'pause');
  assert.equal(room.paused, true);
  room.act('c', 'seek', 100);
  assert.equal(room.position, 0);
  assert.equal(room.withdraw('b', 'nope'), false);
});

test('everyone mode: anyone controls, with attribution for the others', () => {
  const { room, clock } = setup();
  playing(room, 'a');
  clock.advance(10_000);
  room.act('b', 'pause');
  assert.equal(room.paused, true);
  let out = notices(room);
  assert.equal(out[0].text, 'B a mis en pause');
  assert.equal(out[0].except, 'b');
  room.act('c', 'seek', 2530);
  out = notices(room);
  assert.equal(out[0].text, 'C a avancé à 42:10');
  room.act('c', 'seek', 5);
  assert.equal(notices(room)[0].text, 'C a reculé à 0:05');
});

// ------------------------------------------------------------ requests

test('requests: the host accepts', () => {
  const { room } = setup();
  playing(room, 'a');
  room.setControl('a', 'host');
  room.drain();
  room.request('b', 'pause');
  const [n] = notices(room);
  assert.equal(n.to, 'b');
  const [r] = room.snapshot().requests;
  assert.equal(r.kind, 'pause');
  assert.equal(room.respond('c', r.id, true), false, 'only the host answers');
  assert.equal(room.respond('a', r.id, true), true);
  assert.equal(room.paused, true);
  assert.match(notices(room)[0].text, /A a accepté la demande de B \(une pause\)/);
  assert.equal(room.requests.size, 0);
});

test('requests: refused, seek with position, one per person, expiry', () => {
  const { room, clock } = setup();
  playing(room, 'a');
  room.setControl('a', 'host');
  room.request('b', 'seek', 600);
  room.request('b', 'seek', 700);
  assert.equal(room.requests.size, 1, 'a new request replaces the old one');
  const [r] = room.snapshot().requests;
  assert.equal(r.position, 700);
  room.respond('a', r.id, false);
  assert.equal(room.position, 0);
  assert.match(notices(room).at(-1).text, /a refusé la demande de B \(d’aller à 11:40\)/);

  room.request('c', 'pause');
  assert.equal(room.request('a', 'pause'), false, 'the host just pauses');
  clock.advance(REQUEST_TTL_MS - 1);
  room.tick();
  assert.equal(room.requests.size, 1);
  clock.advance(1);
  assert.equal(room.tick(), true);
  assert.equal(room.requests.size, 0);
  assert.match(notices(room).at(-1).text, /La demande de C a expiré/);
});

test('requests are not possible in everyone mode', () => {
  const { room } = setup();
  playing(room, 'a');
  assert.equal(room.request('b', 'pause'), false);
});

// ------------------------------------------------------------ votes to pause / skip

test('vote to pause applies at a strict majority, votes toggle', () => {
  const { room } = setup(['a', 'b', 'c', 'd']);
  playing(room, 'a');
  room.setControl('a', 'host');
  room.voteAction('b', 'pause');
  room.voteAction('c', 'pause');
  assert.equal(room.paused, false, '2 of 4 is not a majority');
  room.voteAction('c', 'pause');
  assert.deepEqual(room.snapshot().votes[0].voters, ['b'], 'toggled off');
  room.voteAction('c', 'pause');
  room.voteAction('d', 'pause');
  assert.equal(room.paused, true);
  assert.equal(room.actionVotes.size, 0);
});

test('vote majority counts only present members; votes expire', () => {
  const { room, clock } = setup();
  playing(room, 'a');
  room.voteAction('b', 'pause');
  assert.equal(room.paused, false);
  room.leave('c');
  // b is now 1 of 2: still not > 50 %.
  assert.equal(room.paused, false);
  clock.advance(ACTION_VOTE_TTL_MS);
  room.tick();
  assert.equal(room.actionVotes.size, 0);
});

test('vote to skip starts the next episode, else the top suggestion, else stops', () => {
  const { room } = setup();
  playing(room, 'a', media({ meta: { id: 'tt1', type: 'series', videoId: 'tt1:1:1' }, next: { videoId: 'tt1:1:2', subtitle: 'S1E02 · Deux' } }));
  room.voteAction('b', 'skip');
  room.voteAction('c', 'skip');
  const [s] = starts(room);
  assert.equal(s.item.meta.videoId, 'tt1:1:2');
  assert.equal(s.item.streamKey, null, 'resolved server-side');

  playing(room, 'a');
  room.propose('b', proposal('tt9'));
  room.voteAction('b', 'skip');
  room.voteAction('c', 'skip');
  assert.equal(starts(room)[0].item.meta.videoId, 'tt9');
  assert.equal(room.queue.size, 0);

  playing(room, 'a');
  room.voteAction('b', 'skip');
  room.voteAction('c', 'skip');
  assert.equal(room.media, null);
});

// ------------------------------------------------------------ suggestions

test('suggestions: proposer votes, sorted by votes then age, toggle, withdraw', () => {
  const { room, clock } = setup();
  playing(room, 'a');
  const x = room.propose('a', proposal('tt1')).item;
  clock.advance(1000);
  const y = room.propose('b', proposal('tt2', { streamKey: 'k', source: '1080p · MULTI' })).item;
  assert.deepEqual(room.sortedQueue().map((q) => q.id), [x.id, y.id], 'same votes: oldest first');
  room.vote('c', y.id);
  assert.deepEqual(room.sortedQueue().map((q) => q.id), [y.id, x.id]);
  room.vote('c', y.id);
  assert.deepEqual(room.sortedQueue().map((q) => q.id), [x.id, y.id], 'vote toggled off');
  room.vote('c', y.id);
  room.vote('c', y.id);
  room.vote('c', y.id);
  assert.equal(room.queue.get(y.id).votes.size, 2, 'one vote per person');

  const snap = room.snapshot().queue.find((q) => q.id === y.id);
  assert.equal(snap.streamKey, undefined, 'stream keys never reach the browser');
  assert.equal(snap.source, '1080p · MULTI');

  assert.equal(room.withdraw('a', y.id), false, 'only the proposer');
  assert.equal(room.withdraw('b', y.id), true);
  assert.equal(room.queue.size, 1);
});

test('suggestions: duplicates become votes, limits, members only', () => {
  const { room } = setup();
  playing(room, 'a');
  const first = room.propose('a', proposal('tt1')).item;
  const again = room.propose('b', proposal('tt1'));
  assert.equal(again.duplicate, true);
  assert.equal(first.votes.size, 2);
  for (let i = 0; i < QUEUE_PER_USER_MAX - 1; i++) assert.ok(room.propose('a', proposal(`tt${100 + i}`)).item);
  assert.match(room.propose('a', proposal('tt999')).error, /Maximum/);
  assert.match(room.propose('zz', proposal('tt5')).error, /pas dans la salle/);
});

test('majority auto-start: countdown, then start with the proposer as host', () => {
  const { room, clock } = setup();
  const item = room.propose('b', proposal('tt1', { streamKey: 'key1' })).item;
  assert.equal(room.autostart, null, '1 of 3');
  room.vote('c', item.id);
  assert.equal(room.autostart.itemId, item.id, '2 of 3 → countdown');
  room.drain();
  clock.advance(AUTOSTART_MS - 1);
  room.tick();
  assert.equal(starts(room).length, 0);
  clock.advance(1);
  room.tick();
  const out = room.drain();
  const start = out.find((e) => e.type === 'start');
  assert.equal(start.item.streamKey, 'key1');
  assert.equal(start.host, 'b');
  assert.ok(out.some((e) => e.type === 'notice' && /La salle a voté pour « Titre tt1 »/.test(e.text)));
  assert.equal(room.queue.size, 0);
  assert.ok(room.snapshot().starting);
  assert.equal(room.isCurrentStart(start.token), true);
  room.load(media({ sid: 's2' }), { by: start.host });
  assert.equal(room.host, 'b');
  assert.equal(room.snapshot().starting, null);
});

test('majority auto-start: anyone cancels; a new vote re-arms it', () => {
  const { room, clock } = setup();
  const item = room.propose('b', proposal('tt1')).item;
  room.vote('c', item.id);
  assert.ok(room.autostart);
  assert.equal(room.cancel('a', 'autostart'), true);
  assert.equal(room.autostart, null);
  clock.advance(AUTOSTART_MS * 2);
  room.tick();
  assert.equal(starts(room).length, 0, 'stays cancelled');
  room.vote('a', item.id);
  assert.ok(room.autostart, 'one more vote re-arms');
});

test('majority auto-start waits for the current film to end', () => {
  const { room, clock } = setup();
  playing(room, 'a', media({ duration: 100 }));
  const item = room.propose('b', proposal('tt1')).item;
  room.vote('c', item.id);
  assert.equal(room.autostart, null, 'something is playing');
  assert.equal(room.canStart('b'), true, 'everyone mode');
  clock.advance(99_500);
  room.tick();
  assert.ok(room.autostart, 'film over');
});

test('manual start of a suggestion: anyone when idle, only the host while playing in host mode', () => {
  const { room } = setup();
  playing(room, 'a');
  room.setControl('a', 'host');
  const item = room.propose('b', proposal('tt1')).item;
  assert.equal(room.startSuggestion('b', item.id), false);
  room.stop();
  assert.equal(room.startSuggestion('b', item.id), true);
  const [s] = starts(room);
  assert.equal(s.host, 'b');
});

test('a newer start supersedes an older one; a failed start clears the state', () => {
  const { room } = setup();
  const t1 = room.beginStart({ title: 'A', by: 'a' });
  const t2 = room.beginStart({ title: 'B', by: 'b' });
  assert.equal(room.isCurrentStart(t1), false);
  assert.equal(room.failStart(t1), false);
  assert.equal(room.failStart(t2), true);
  assert.equal(room.starting, null);
});

// ------------------------------------------------------------ auto-next

test('auto-next: countdown at the end of an episode, then the next one', () => {
  const { room, clock } = setup();
  const ep = media({ duration: 100, startedByUid: 'a', meta: { id: 'tt1', type: 'series', videoId: 'tt1:1:1' }, title: 'Série' });
  playing(room, 'a', ep);
  room.setNext('s1', { videoId: 'tt1:1:2', subtitle: 'S1E02 · Deux' });
  assert.equal(room.snapshot().media.startedByUid, undefined, 'server-only field');
  clock.advance(98_000);
  room.tick();
  assert.equal(room.autonext, null);
  clock.advance(1500);
  room.tick();
  assert.ok(room.autonext);
  assert.equal(room.snapshot().autonext.subtitle, 'S1E02 · Deux');
  clock.advance(AUTONEXT_MS);
  room.tick();
  const [s] = starts(room);
  assert.deepEqual(s.item.meta, { id: 'tt1', type: 'series', videoId: 'tt1:1:2' });
  assert.equal(s.item.uid, 'a', "the starter's addons");
});

test('auto-next: cancel rights follow the control mode', () => {
  const { room, clock } = setup();
  const ep = media({ duration: 100, meta: { id: 'tt1', type: 'series', videoId: 'tt1:1:1' } });
  playing(room, 'a', ep);
  room.setNext('s1', { videoId: 'tt1:1:2', subtitle: 'S1E02' });
  room.setControl('b', 'host');
  clock.advance(100_000);
  room.tick();
  assert.ok(room.autonext);
  assert.equal(room.cancel('b', 'autonext'), false, 'not the host');
  assert.equal(room.cancel('a', 'autonext'), true);
  clock.advance(AUTONEXT_MS * 2);
  room.tick();
  assert.equal(room.autonext, null, 'stays cancelled for this episode');
  assert.equal(starts(room).length, 0);
});

test('auto-next ignores a stale session and needs someone in the room', () => {
  const { room, clock } = setup(['a']);
  const ep = media({ duration: 100 });
  playing(room, 'a', ep);
  assert.equal(room.setNext('other', { videoId: 'x', subtitle: '' }), false);
  room.setNext('s1', { videoId: 'tt1:1:2', subtitle: 'S1E02' });
  room.leave('a');
  clock.advance(200_000);
  room.tick();
  assert.equal(room.autonext, null);
});

// ------------------------------------------------------------ presence & snapshot

test('member state: loading, watching, browsing', () => {
  const { room } = setup(['a', 'b']);
  room.load(media(), { by: 'a' });
  room.setBuffering('a', false);
  room.setPresence('a', 'browsing');
  assert.equal(room.setPresence('a', 'nope'), false);
  const states = Object.fromEntries(room.snapshot().members.map((m) => [m.uid, m.state]));
  assert.deepEqual(states, { a: 'browsing', b: 'loading' });
  room.setBuffering('b', false);
  assert.equal(room.snapshot().members.find((m) => m.uid === 'b').state, 'watching');
});

test('helpers', () => {
  assert.equal(formatTime(2530), '42:10');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(mediaLabel({ title: 'Série', subtitle: 'S1E04 · Pilote' }), 'Série · S1E04');
  assert.equal(mediaLabel({ title: 'Dune', subtitle: '' }), 'Dune');
});

test('load timeout still applies to a rejoin after the room emptied', () => {
  const { room, clock } = setup(['a']);
  playing(room, 'a');
  room.leave('a');
  room.join({ uid: 'b', name: 'B' });
  clock.advance(LOAD_TIMEOUT_MS);
  room.tick();
  assert.equal(room.running, true);
});
