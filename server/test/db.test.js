import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskUrl, openStore } from '../src/db.js';

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const store = openStore(':memory:', { now: clock.now });
  store.upsertUser({ uid: 'alice', name: 'Alice', avatar: null });
  store.upsertUser({ uid: 'bob', name: 'Bob', avatar: null });
  return { store, clock };
}

const movie = { videoId: 'tt1', metaId: 'tt1', metaType: 'movie', name: 'Film', poster: 'https://p/1.jpg' };
const ep = (s, e) => ({ videoId: `tt2:${s}:${e}`, metaId: 'tt2', metaType: 'series', name: 'Série', episode: `S${s}E${e}` });

test('migrations are idempotent across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-db-'));
  try {
    const a = openStore(dir);
    a.upsertUser({ uid: 'u', name: 'U' });
    a.saveProgress('u', { ...movie, position: 100, duration: 1000 });
    a.close();
    const b = openStore(dir);
    b.migrate();
    assert.equal(b.history('u').length, 1);
    assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 1);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('users are created once and refreshed on later logins', () => {
  const { store, clock } = setup();
  const created = store.getUser('alice').createdAt;
  clock.advance(1000);
  store.upsertUser({ uid: 'alice', name: 'Alice 2', avatar: 'https://cdn.discordapp.com/a.png' });
  const u = store.getUser('alice');
  assert.equal(u.name, 'Alice 2');
  assert.equal(u.createdAt, created);
  assert.equal(u.guest, false);
  store.upsertUser({ uid: 'guest:zoe', name: 'Zoé', guest: true });
  assert.equal(store.getUser('guest:zoe').guest, true);
});

test('progress: update in place, watched above 90 % and sticky', () => {
  const { store, clock } = setup();
  store.saveProgress('alice', { ...movie, position: 60, duration: 1000 });
  clock.advance(1000);
  store.saveProgress('alice', { ...movie, position: 500, duration: 1000 });
  let [p] = store.progressFor('alice', 'tt1');
  assert.equal(p.position, 500);
  assert.equal(p.watched, false);

  store.saveProgress('alice', { ...movie, position: 950, duration: 1000 });
  [p] = store.progressFor('alice', 'tt1');
  assert.equal(p.watched, true);

  store.saveProgress('alice', { ...movie, position: 30, duration: 1000 }); // rewatch
  [p] = store.progressFor('alice', 'tt1');
  assert.equal(p.watched, true, 'watched mark stays');
  assert.equal(p.position, 30);
});

test('progress rejects junk and clamps to the duration', () => {
  const { store } = setup();
  assert.equal(store.saveProgress('alice', { ...movie, position: -1, duration: 10 }), false);
  assert.equal(store.saveProgress('alice', { ...movie, position: NaN }), false);
  assert.equal(store.saveProgress('alice', { ...movie, videoId: '' , position: 1 }), false);
  store.saveProgress('alice', { ...movie, position: 5000, duration: 1000 });
  assert.equal(store.progressFor('alice', 'tt1')[0].position, 1000);
});

test('history: one line per title, latest episode, most recent first, per user', () => {
  const { store, clock } = setup();
  store.saveProgress('alice', { ...ep(1, 1), position: 1200, duration: 1300 });
  clock.advance(1000);
  store.saveProgress('alice', { ...movie, position: 300, duration: 6000 });
  clock.advance(1000);
  store.saveProgress('alice', { ...ep(1, 2), position: 200, duration: 1300 });
  store.saveProgress('bob', { ...movie, position: 10, duration: 6000 });

  const h = store.history('alice');
  assert.deepEqual(h.map((p) => p.videoId), ['tt2:1:2', 'tt1']);
  assert.equal(store.history('bob').length, 1);
  assert.equal(store.progressFor('alice', 'tt2').length, 2);
});

test('continue watching skips finished and barely started titles', () => {
  const { store, clock } = setup();
  store.saveProgress('alice', { ...movie, position: 5, duration: 6000 });
  clock.advance(10);
  store.saveProgress('alice', { ...ep(1, 1), position: 1250, duration: 1300 });
  assert.equal(store.continueWatching('alice').length, 0);
  clock.advance(10);
  store.saveProgress('alice', { ...movie, position: 2500, duration: 6000 });
  assert.deepEqual(store.continueWatching('alice').map((p) => p.metaId), ['tt1']);
});

test('remove from history only touches that user and title', () => {
  const { store } = setup();
  store.saveProgress('alice', { ...ep(1, 1), position: 100, duration: 1300 });
  store.saveProgress('alice', { ...ep(1, 2), position: 100, duration: 1300 });
  store.saveProgress('alice', { ...movie, position: 100, duration: 1300 });
  store.saveProgress('bob', { ...ep(1, 1), position: 100, duration: 1300 });
  assert.equal(store.removeHistory('alice', 'tt2'), true);
  assert.deepEqual(store.history('alice').map((p) => p.metaId), ['tt1']);
  assert.equal(store.history('bob').length, 1);
  assert.equal(store.removeHistory('alice', 'tt2'), false);
});

test('library: add, dedupe, filter by type, sort, remove', () => {
  const { store, clock } = setup();
  store.addToLibrary('alice', { metaId: 'tt1', metaType: 'movie', name: 'Zodiac', year: '2007' });
  clock.advance(10);
  store.addToLibrary('alice', { metaId: 'tt2', metaType: 'series', name: 'arcane' });
  clock.advance(10);
  store.addToLibrary('alice', { metaId: 'tt3', metaType: 'movie', name: 'Alien' });
  store.addToLibrary('alice', { metaId: 'tt3', metaType: 'movie', name: 'Alien' });

  assert.deepEqual(store.library('alice').map((e) => e.id), ['tt3', 'tt2', 'tt1']);
  assert.deepEqual(store.library('alice', { sort: 'name' }).map((e) => e.name), ['Alien', 'arcane', 'Zodiac']);
  assert.deepEqual(store.library('alice', { type: 'movie' }).map((e) => e.id), ['tt3', 'tt1']);
  assert.equal(store.inLibrary('alice', 'tt2'), true);
  assert.equal(store.inLibrary('bob', 'tt2'), false);
  assert.equal(store.removeFromLibrary('bob', 'tt2'), false);
  assert.equal(store.removeFromLibrary('alice', 'tt2'), true);
  assert.equal(store.library('alice').length, 2);
});

test('personal addons never expose their URL', () => {
  const { store } = setup();
  const url = 'https://torrentio.strem.fun/realdebrid=SECRETKEY/manifest.json';
  const id = store.addAddon('alice', url, 'Torrentio RD');
  const [listed] = store.listAddons('alice');
  assert.equal(listed.id, id);
  assert.ok(!JSON.stringify(listed).includes('SECRETKEY'));
  assert.deepEqual(store.addonUrls('alice'), [url]);
  assert.deepEqual(store.addonUrls('bob'), []);
  assert.equal(store.removeAddon('bob', id), false);
  assert.equal(store.removeAddon('alice', id), true);
});

test('maskUrl hides path and query secrets', () => {
  assert.equal(maskUrl('https://a.example/key=1/manifest.json'), 'https://a.example/••••/manifest.json');
  assert.equal(maskUrl('https://a.example/manifest.json'), 'https://a.example/manifest.json');
  assert.equal(maskUrl('https://a.example/manifest.json?token=x'), 'https://a.example/••••/manifest.json');
  assert.equal(maskUrl('nope'), '••••');
});
