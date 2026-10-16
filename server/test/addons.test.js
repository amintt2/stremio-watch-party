import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browsableCatalogs, pickBestStream, sourceLabel } from '../src/addons.js';

test('server-side best source: MULTI, then débrid, then 1080p, then seeders (like the client)', () => {
  const s = (id, o) => ({ id, cached: false, quality: null, seeders: null, languages: [], ...o });
  const list = [
    s('4k', { quality: '4K', seeders: 900 }),
    s('1080', { quality: '1080p', seeders: 10 }),
    s('1080-more', { quality: '1080p', seeders: 50 }),
    s('cached-720', { quality: '720p', cached: true }),
    s('multi-720', { quality: '720p', languages: ['MULTI'] }),
  ];
  assert.equal(pickBestStream(list).id, 'multi-720');
  assert.equal(pickBestStream(list.slice(0, 4)).id, 'cached-720');
  assert.equal(pickBestStream(list.slice(0, 3)).id, '1080-more');
  assert.equal(pickBestStream([]), null);
});

test('source label for the queue has no URL', () => {
  const label = sourceLabel({ name: 'Torrentio\n1080p [RD+]', title: 'Film.2024.MULTI.1080p.mkv', url: 'https://secret.example/key' });
  assert.equal(label, '1080p · MULTI · ⚡ Débrid');
});

// Trimmed copy of Cinemeta's manifest.
const manifest = {
  catalogs: [
    { type: 'movie', id: 'top', name: 'Popular', extra: [{ name: 'genre', options: ['Action', 'Drama'] }, { name: 'search' }, { name: 'skip' }] },
    { type: 'movie', id: 'year', name: 'New', extra: [{ name: 'genre', options: ['2026', '2025'], isRequired: true }, { name: 'skip' }] },
    { type: 'series', id: 'last-videos', name: 'Last videos', extra: [{ name: 'lastVideosIds', isRequired: true }] },
    { type: 'series', id: 'search-only', extra: [{ name: 'search', isRequired: true }] },
    { type: 'channel', id: 'top', extra: [] },
    { type: 'series', id: 'legacy', name: 'Old style', genres: ['Comedy'], extraSupported: ['genre'] },
  ],
};

test('catalogs come from the manifest, unbrowsable ones are dropped', () => {
  const list = browsableCatalogs(manifest);
  assert.deepEqual(
    list.map((c) => `${c.type}/${c.id}`),
    ['movie/top', 'movie/year', 'series/legacy']
  );
  const [top, year, legacy] = list;
  assert.equal(top.home, true);
  assert.deepEqual(top.genres, ['Action', 'Drama']);
  assert.equal(top.skip, true);
  assert.equal(year.home, false, 'needs a genre: discover only');
  assert.equal(year.genreRequired, true);
  assert.deepEqual(legacy.genres, ['Comedy']);
  assert.equal(legacy.skip, false);
  assert.deepEqual(browsableCatalogs(null), []);
});
