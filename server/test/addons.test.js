import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browsableCatalogs, normalizeMeta } from '../src/addons.js';

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

test('meta extras: trailer, IMDb, writers, similar titles from links', () => {
  const m = normalizeMeta({
    id: 'tt0903747',
    type: 'series',
    name: 'Breaking Bad',
    imdbRating: '9.5',
    trailers: [{ source: 'bad id with spaces' }, { source: 'VFkjBy2b50Q', type: 'Trailer' }],
    links: [
      { name: '9.5', category: 'imdb', url: 'https://imdb.com/title/tt0903747' },
      { name: 'Vince Gilligan', category: 'Writers', url: 'stremio:///search?search=Vince' },
      { name: 'Better Call Saul', category: 'Similar', url: 'stremio:///detail/series/tt3032476' },
      { name: 'Broken', category: 'Similar', url: 'https://example.com' },
    ],
    videos: [
      { id: 'x:1:2', season: 1, episode: 2, firstAired: '2008-01-28' },
      { id: 'x:1:1', season: 1, episode: 1, name: 'Pilot', released: '2008-01-21' },
      { id: 'junk' },
    ],
  });
  assert.equal(m.trailer, 'VFkjBy2b50Q');
  assert.equal(m.imdbId, 'tt0903747');
  assert.deepEqual(m.writers, ['Vince Gilligan']);
  assert.deepEqual(m.similar, [{ type: 'series', id: 'tt3032476', name: 'Better Call Saul' }]);
  assert.deepEqual(m.videos.map((v) => [v.id, v.title, v.released]), [
    ['x:1:1', 'Pilot', '2008-01-21'],
    ['x:1:2', 'Épisode 2', '2008-01-28'],
  ]);
  const bare = normalizeMeta({ id: 'kitsu:1', type: 'movie', name: 'X' });
  assert.equal(bare.imdbId, null);
  assert.equal(bare.trailer, null);
  assert.deepEqual(bare.similar, []);
});
