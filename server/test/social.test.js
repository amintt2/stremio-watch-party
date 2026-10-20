import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_VOTE_TTL_MS,
  AUTONEXT_MS,
  AUTOSTART_MS,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  LIMITS,
  LOAD_TIMEOUT_MS,
  QUEUE_PER_USER_MAX,
  REFUSE_BLOCK_MS,
  REQUEST_TTL_MS,
  Room,
  Rooms,
  SPAM_COOLDOWN_MS,
  formatTime,
  majority,
  mediaLabel,
} from '../src/rooms.js';

function setup(uids = ['a', 'b', 'c'], options = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const room = new Room('r', { now: clock.now, ...options });
  for (const uid of uids) {
    room.join({ uid, name: uid.toUpperCase() });
    if (room.status(uid) === 'pending') room.admit(uids[0], uid); // waiting room: let in
  }
  room.drain();
  return { room, clock };
}

const media = (extra = {}) => ({ sid: 's1', duration: 3600, title: 'Film', subtitle: '', ...extra });

/** Loads and marks everyone ready. */
function playing(room, m = media()) {
  room.load(m);
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
  playing(room);
  clock.advance(30_000);
  room.leave('a');
  assert.ok(room.media, 'media kept');
  assert.equal(room.running, true);
  clock.advance(10_000);
  assert.equal(room.currentPosition(), 40);
});

test('the starter being the only one still loading and leaving unblocks the room', () => {
  const { room, clock } = setup();
  room.load(media());
  room.setBuffering('b', false);
  room.setBuffering('c', false);
  assert.equal(room.running, false);
  room.leave('a');
  assert.equal(room.running, true);
  clock.advance(2000);
  assert.equal(room.currentPosition(), 2);
});

test('a reconnect keeps the film running and the role', () => {
  const { room, clock } = setup();
  playing(room);
  room.setCopilot('a', 'b', true);
  clock.advance(5000);
  room.leave('a');
  room.leave('b');
  room.join({ uid: 'b', name: 'B' });
  room.join({ uid: 'a', name: 'A' });
  assert.equal(room.running, true, 'a rejoiner is not a load barrier');
  assert.equal(room.host, 'a', 'host back within the grace period');
  assert.equal(room.isModerator('b'), true, 'still co-pilote');
  clock.advance(HOST_GRACE_MS * 2);
  room.tick();
  assert.equal(room.host, 'a');
  clock.advance(1000);
  assert.equal(room.currentPosition(), 6 + HOST_GRACE_MS * 2 / 1000);
});

test('last person leaving keeps the film paused; a quick rejoin resumes it', () => {
  const { room, clock } = setup(['a']);
  playing(room);
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
  assert.equal(room.host, 'b', 'alone: b drives');
  assert.equal(room.copilots.has('a'), true, 'a gets control back as co-pilote');
});

test('a paused film stays paused when the room is emptied and rejoined', () => {
  const { room } = setup(['a']);
  playing(room);
  room.pause();
  room.leave('a');
  room.join({ uid: 'a', name: 'A' });
  assert.equal(room.paused, true);
});

test('empty rooms are kept for a while, then swept', () => {
  let t = 0;
  const rooms = new Rooms({ now: () => t });
  const room = rooms.get('x', { lobby: true });
  assert.equal(room.lobby, true);
  room.join({ uid: 'a', name: 'A' });
  room.load(media());
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

// ------------------------------------------------------------ roles & handover

test('the first one in is the host; starting a film does not move the crown', () => {
  const { room } = setup();
  assert.equal(room.host, 'a');
  assert.equal(room.control, 'host', 'protected by default');
  room.setCopilot('a', 'b', true);
  playing(room);
  assert.equal(room.host, 'a');
});

test('host away: replaced after the grace period by the longest-present co-pilote', () => {
  const { room, clock } = setup(['a', 'b', 'c', 'd']);
  room.setCopilot('a', 'd', true);
  room.leave('a');
  room.tick();
  assert.equal(room.host, 'a', 'grace period');
  clock.advance(HOST_GRACE_MS);
  room.tick();
  assert.equal(room.host, 'd', 'co-pilote first, even if b was there before');
  assert.match(notices(room).at(-1).text, /D est maintenant l’hôte/);
  room.join({ uid: 'a', name: 'A' });
  assert.equal(room.host, 'd');
  assert.equal(room.isModerator('a'), true, 'former host comes back as co-pilote');
});

test('host away without co-pilotes: the longest-present member', () => {
  const { room, clock } = setup(['a', 'b', 'c']);
  room.leave('a');
  clock.advance(HOST_GRACE_MS);
  room.tick();
  assert.equal(room.host, 'b');
});

test('hand over, promote, revoke: host only', () => {
  const { room } = setup();
  assert.equal(room.handOver('b', 'c'), false);
  assert.equal(room.setCopilot('b', 'c', true), false);
  assert.equal(room.handOver('a', 'zz'), false);
  assert.equal(room.setCopilot('a', 'b', true), true);
  assert.equal(room.setCopilot('b', 'c', true), false, 'a co-pilote cannot promote');
  assert.equal(room.setCopilot('a', 'b', false), true);
  assert.equal(room.isModerator('b'), false);
  assert.equal(room.handOver('a', 'c'), true);
  assert.equal(room.host, 'c');
  assert.equal(room.isModerator('a'), true, 'the former host stays co-pilote');
});

test('control mode: protected by default, only the host switches it', () => {
  const { room } = setup();
  assert.equal(room.setControl('b', 'all'), false);
  assert.equal(room.setControl('a', 'all'), true);
  assert.equal(room.canControl('c'), true);
  assert.equal(room.setControl('b', 'host'), false, 'not the host');
  assert.equal(room.setControl('a', 'host'), true);
  assert.equal(room.setControl('a', 'bogus'), false);
});

// ------------------------------------------------------------ permissions

test('protected: viewers cannot play, pause, seek, stop or start; their actions become requests', () => {
  const { room } = setup();
  playing(room);
  room.setCopilot('a', 'b', true);
  assert.equal(room.canControl('c'), false);
  assert.equal(room.canStart('c'), false);
  room.act('c', 'pause');
  assert.equal(room.paused, false, 'not applied');
  assert.equal(room.requests.size, 1, 'turned into a request');
  room.act('c', 'seek', 100);
  assert.equal(room.position, 0);
  assert.equal(room.stopBy('c'), false);
  assert.equal(room.beginStartBy('c', { title: 'X' }), null);
  assert.ok(room.media);
  room.act('b', 'pause');
  assert.equal(room.paused, true, 'co-pilote controls');
  assert.equal(room.stopBy('b'), true);
  assert.equal(room.media, null);
  assert.equal(room.canStart('c'), false, 'idle does not give viewers the remote');
});

test('non-members and waiting people can do nothing', () => {
  const { room } = setup(['a', 'b'], { lobby: true });
  playing(room);
  room.join({ uid: 'x', name: 'X' });
  assert.equal(room.status('x'), 'pending');
  for (const fn of [
    () => room.act('x', 'pause'),
    () => room.request('x', 'pause'),
    () => room.voteAction('x', 'pause'),
    () => room.setBuffering('x', true),
    () => room.setPresence('x', 'browsing'),
    () => room.cancel('x', 'autonext'),
  ]) assert.equal(fn(), false);
  assert.match(room.propose('x', proposal('tt1')).error, /pas dans la salle/);
  assert.equal(room.running, true);
});

test('everyone mode: anyone controls, with attribution for the others', () => {
  const { room, clock } = setup();
  room.setControl('a', 'all');
  playing(room);
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

test('requests: a co-pilote accepts', () => {
  const { room } = setup();
  playing(room);
  room.setCopilot('a', 'b', true);
  room.drain();
  room.request('c', 'pause');
  const [n] = notices(room);
  assert.equal(n.to, 'c');
  const [r] = room.snapshot().requests;
  assert.equal(r.kind, 'pause');
  assert.equal(r.label, 'une pause');
  assert.equal(room.respond('c', r.id, true), false, 'not a moderator');
  assert.equal(room.respond('b', r.id, true), true);
  assert.equal(room.paused, true);
  assert.match(notices(room)[0].text, /B a accepté la demande de C \(une pause\)/);
  assert.equal(room.requests.size, 0);
});

test('requests: refused, seek with position, one per person, expiry', () => {
  const { room, clock } = setup();
  playing(room);
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
  const expired = notices(room).at(-1);
  assert.match(expired.text, /a expiré/);
  assert.equal(expired.to, 'c');
});

test('requests: asking to start a suggestion; accepting starts it', () => {
  const { room } = setup();
  const item = room.propose('c', proposal('tt7')).item;
  assert.equal(room.startSuggestion('c', item.id), true, 'becomes a request');
  assert.equal(starts(room).length, 0);
  const [r] = room.snapshot().requests;
  assert.equal(r.kind, 'start');
  assert.equal(r.itemId, item.id);
  room.respond('a', r.id, true);
  const [s] = starts(room);
  assert.equal(s.item.meta.videoId, 'tt7');
  assert.equal(s.by, 'a');
});

test('requests are not needed in everyone mode', () => {
  const { room } = setup();
  room.setControl('a', 'all');
  playing(room);
  assert.equal(room.request('b', 'pause'), false);
});

// ------------------------------------------------------------ votes to pause / skip

test('votes need a strict majority and at least 2 votes', () => {
  assert.equal(majority(1, 1), false);
  assert.equal(majority(2, 2), true);
  assert.equal(majority(2, 4), false);
  assert.equal(majority(3, 4), true);
});

test('vote to pause applies at a strict majority, votes toggle', () => {
  const { room } = setup(['a', 'b', 'c', 'd']);
  playing(room);
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
  playing(room);
  room.voteAction('b', 'pause');
  room.leave('c');
  assert.equal(room.paused, false, '1 vote never decides');
  clock.advance(ACTION_VOTE_TTL_MS);
  room.tick();
  assert.equal(room.actionVotes.size, 0);
});

test('vote to skip starts the next episode, else the top suggestion, else stops', () => {
  const { room } = setup();
  playing(room, media({ meta: { id: 'tt1', type: 'series', videoId: 'tt1:1:1' }, next: { videoId: 'tt1:1:2', subtitle: 'S1E02 · Deux' } }));
  room.voteAction('b', 'skip');
  room.voteAction('c', 'skip');
  const [s] = starts(room);
  assert.equal(s.item.meta.videoId, 'tt1:1:2');
  assert.equal(s.item.streamKey, null, 'resolved server-side');

  playing(room);
  room.propose('b', proposal('tt9'));
  room.voteAction('b', 'skip');
  room.voteAction('c', 'skip');
  assert.equal(starts(room)[0].item.meta.videoId, 'tt9');
  assert.equal(room.queue.size, 0);

  playing(room);
  room.voteAction('b', 'skip');
  room.voteAction('c', 'skip');
  assert.equal(room.media, null);
});

// ------------------------------------------------------------ suggestions

test('suggestions: proposer votes, sorted by votes then age, toggle, withdraw', () => {
  const { room, clock } = setup();
  playing(room);
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

  assert.equal(room.withdraw('c', y.id), false, 'only the proposer or a moderator');
  assert.equal(room.withdraw('b', y.id), true);
  assert.equal(room.withdraw('a', x.id), true, 'the host may remove any');
  assert.equal(room.queue.size, 0);
});

test('suggestions: duplicates become votes, limits, members only', () => {
  const { room } = setup();
  const first = room.propose('b', proposal('tt1')).item;
  const again = room.propose('c', proposal('tt1'));
  assert.equal(again.duplicate, true);
  assert.equal(first.votes.size, 2);
  for (let i = 0; i < QUEUE_PER_USER_MAX - 1; i++) assert.ok(room.propose('b', proposal(`tt${100 + i}`)).item);
  assert.match(room.propose('c', proposal('tt999')).error ?? '', /^$/, 'c still may');
  assert.match(room.propose('zz', proposal('tt5')).error, /pas dans la salle/);
});

test('majority auto-start: countdown, then start (proposer’s addons)', () => {
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
  assert.equal(start.item.uid, 'b');
  assert.ok(out.some((e) => e.type === 'notice' && /La salle a voté pour « Titre tt1 »/.test(e.text)));
  assert.equal(room.queue.size, 0);
  assert.ok(room.snapshot().starting);
  assert.equal(room.isCurrentStart(start.token), true);
  room.load(media({ sid: 's2' }));
  assert.equal(room.snapshot().starting, null);
  assert.equal(room.host, 'a', 'the crown does not move');
});

test('majority auto-start: a single voter never decides, even alone with the host away', () => {
  const { room } = setup(['a', 'b']);
  room.leave('a');
  room.propose('b', proposal('tt1'));
  assert.equal(room.autostart, null);
});

test('majority auto-start: controllers cancel; a new vote re-arms it', () => {
  const { room, clock } = setup(['a', 'b', 'c', 'd']);
  const item = room.propose('b', proposal('tt1')).item;
  room.vote('c', item.id);
  room.vote('d', item.id);
  assert.ok(room.autostart);
  assert.equal(room.cancel('c', 'autostart'), false, 'viewers cannot cancel');
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
  playing(room, media({ duration: 100 }));
  const item = room.propose('b', proposal('tt1')).item;
  room.vote('c', item.id);
  assert.equal(room.autostart, null, 'something is playing');
  clock.advance(99_500);
  room.tick();
  assert.ok(room.autostart, 'film over');
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
  playing(room, ep);
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
  playing(room, ep);
  room.setNext('s1', { videoId: 'tt1:1:2', subtitle: 'S1E02' });
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
  playing(room, media({ duration: 100 }));
  assert.equal(room.setNext('other', { videoId: 'x', subtitle: '' }), false);
  room.setNext('s1', { videoId: 'tt1:1:2', subtitle: 'S1E02' });
  room.leave('a');
  clock.advance(200_000);
  room.tick();
  assert.equal(room.autonext, null);
});

// ------------------------------------------------------------ waiting room

test('waiting room: newcomers wait; a co-pilote lets them in; admission survives a reconnect', () => {
  const { room } = setup(['a', 'b'], { lobby: true });
  room.setCopilot('a', 'b', true);
  room.drain();
  room.join({ uid: 'x', name: 'X' });
  assert.equal(room.status('x'), 'pending');
  assert.equal(room.members.has('x'), false);
  const knock = notices(room)[0];
  assert.match(knock.text, /X attend pour entrer/);
  assert.deepEqual(knock.to.sort(), ['a', 'b'], 'told to moderators only');
  assert.deepEqual(room.snapshot().pending.map((p) => p.uid), ['x']);
  assert.equal(room.admit('x', 'x'), false);
  assert.equal(room.admit('b', 'x'), true);
  assert.equal(room.status('x'), 'member');
  assert.equal(room.canControl('x'), false, 'joins without control');
  room.leave('x');
  room.join({ uid: 'x', name: 'X' });
  assert.equal(room.status('x'), 'member', 'no second wait');
});

test('waiting room: refused people are blocked for a while', () => {
  const { room, clock } = setup(['a'], { lobby: true });
  room.join({ uid: 'x', name: 'X' });
  assert.equal(room.refuse('x', 'x'), false);
  assert.equal(room.refuse('a', 'x'), true);
  assert.deepEqual(room.drain().find((e) => e.type === 'kick'), { type: 'kick', uid: 'x', reason: 'refused' });
  assert.equal(room.status('x'), 'blocked');
  assert.equal(room.join({ uid: 'x', name: 'X' }), false);
  clock.advance(REFUSE_BLOCK_MS);
  room.join({ uid: 'x', name: 'X' });
  assert.equal(room.status('x'), 'pending', 'may knock again later');
});

test('waiting room: automatic admission, owner always in, Discord rooms have none', () => {
  const { room } = setup(['a'], { lobby: true, owner: 'o' });
  room.join({ uid: 'x', name: 'X' });
  assert.equal(room.setAutoAdmit('x', true), false);
  assert.equal(room.setAutoAdmit('a', true), true);
  assert.equal(room.status('x'), 'member', 'waiting people let in');
  room.join({ uid: 'y', name: 'Y' });
  assert.equal(room.status('y'), 'member');
  room.join({ uid: 'o', name: 'Owner' });
  assert.equal(room.host, 'o', 'the owner of a personal room takes the crown');
  assert.equal(room.isModerator('a'), true);

  const discord = setup(['a']).room;
  discord.join({ uid: 'x', name: 'X' });
  assert.equal(discord.status('x'), 'member');
  assert.equal(discord.canControl('x'), false);
});

test('waiting room: if everybody inside leaves, the first one waiting gets in', () => {
  const { room } = setup(['a'], { lobby: true });
  room.join({ uid: 'x', name: 'X' });
  room.leave('a');
  assert.equal(room.status('x'), 'member');
  assert.equal(room.host, 'x');
});

// ------------------------------------------------------------ moderation

test('kick: host only, removes everything, blocks rejoining', () => {
  const { room } = setup();
  playing(room);
  room.setCopilot('a', 'b', true);
  const item = room.propose('c', proposal('tt1')).item;
  room.vote('b', item.id);
  room.request('c', 'pause');
  room.drain();
  assert.equal(room.kick('b', 'c'), false, 'a co-pilote cannot kick');
  assert.equal(room.kick('a', 'a'), false);
  assert.equal(room.kick('a', 'c'), true);
  const out = room.drain();
  assert.deepEqual(out.find((e) => e.type === 'kick'), { type: 'kick', uid: 'c', reason: 'kicked' });
  assert.equal(room.members.has('c'), false);
  assert.equal(room.queue.size, 0, 'their suggestions go');
  assert.equal(room.requests.size, 0);
  assert.equal(room.status('c'), 'blocked');
  assert.equal(room.join({ uid: 'c', name: 'C' }), false);
  assert.equal(room.members.has('c'), false);
  assert.equal(room.running, true, 'the film goes on');
});

test('kick a co-pilote revokes them', () => {
  const { room } = setup();
  room.setCopilot('a', 'b', true);
  room.kick('a', 'b');
  assert.equal(room.copilots.has('b'), false);
});

// ------------------------------------------------------------ rate limits

test('rate limit: request spam mutes the spammer and tells the moderators', () => {
  const { room, clock } = setup();
  playing(room);
  const [max] = LIMITS.request;
  for (let i = 0; i < max; i++) assert.equal(room.request('c', 'seek', i * 10), true);
  assert.equal(room.request('c', 'seek', 999), false);
  const out = notices(room);
  assert.ok(out.some((n) => n.to === 'c' && /Doucement/.test(n.text)));
  const mods = out.find((n) => /envoie trop d’actions/.test(n.text));
  assert.deepEqual(mods.to, ['a']);
  assert.equal(room.isMuted('c'), true);
  assert.equal(room.voteAction('c', 'pause'), false, 'muted for every action');
  clock.advance(SPAM_COOLDOWN_MS);
  assert.equal(room.isMuted('c'), false);
  assert.equal(room.request('c', 'pause'), true);
});

test('rate limit: co-pilote seek spam is limited, the host is not', () => {
  const { room } = setup();
  playing(room);
  room.setCopilot('a', 'b', true);
  const [max] = LIMITS.control;
  for (let i = 0; i < max; i++) assert.equal(room.act('b', 'seek', i + 1), true);
  assert.equal(room.act('b', 'seek', 500), false);
  for (let i = 0; i < max * 3; i++) assert.equal(room.act('a', 'seek', i + 1), true);
});

test('rate limit: votes and proposals', () => {
  const { room } = setup();
  const item = room.propose('a', proposal('tt1')).item;
  const [maxVotes] = LIMITS.vote;
  for (let i = 0; i < maxVotes; i++) room.vote('c', item.id);
  assert.equal(room.vote('c', item.id), false);
  const [maxProposals] = LIMITS.propose;
  const { room: r2 } = setup();
  let errors = 0;
  for (let i = 0; i < maxProposals + 1; i++) if (r2.propose('b', proposal(`tt${i}`)).error) errors++;
  assert.equal(errors, 1);
});

test('stalls never freeze the room, even again and again', () => {
  const { room } = setup(['a', 'b']);
  playing(room);
  for (let i = 0; i < 10; i++) assert.equal(room.setBuffering('b', true), false);
  assert.equal(room.running, true);
});

// ------------------------------------------------------------ presence & helpers

test('member state: loading, watching, browsing', () => {
  const { room } = setup(['a', 'b']);
  room.load(media());
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
  playing(room);
  room.leave('a');
  room.join({ uid: 'b', name: 'B' });
  clock.advance(LOAD_TIMEOUT_MS);
  room.tick();
  assert.equal(room.running, true);
});
