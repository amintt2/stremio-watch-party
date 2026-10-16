import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browsableCatalogs } from '../src/addons.js';

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
