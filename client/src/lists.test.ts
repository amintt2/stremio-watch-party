import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultEpisode,
  discoverState,
  fold,
  isUpcoming,
  isYearList,
  nextEpisode,
  parseLibrarySort,
  parseResultSort,
  sortLabel,
  sortLibrary,
  sortResults,
  typeCounts,
} from './lists.ts';

const lib = [
  { id: 'a', type: 'movie' as const, name: 'Zodiac', year: '2007', rating: '7.7', addedAt: 1, lastWatchedAt: null },
  { id: 'b', type: 'series' as const, name: 'arcane', year: '2021', rating: '9.0', addedAt: 3, lastWatchedAt: 50 },
  { id: 'c', type: 'movie' as const, name: 'Amélie', year: null, rating: null, addedAt: 2, lastWatchedAt: 90 },
];

test('library sorts, null values last', () => {
  const ids = (sort: Parameters<typeof sortLibrary>[1]['sort']) => sortLibrary(lib, { sort }).map((i) => i.id);
  assert.deepEqual(ids('recent'), ['b', 'c', 'a']);
  assert.deepEqual(ids('name'), ['c', 'b', 'a']);
  assert.deepEqual(ids('year'), ['b', 'a', 'c']);
  assert.deepEqual(ids('rating'), ['b', 'a', 'c']);
  assert.deepEqual(ids('watched'), ['c', 'b', 'a']);
  assert.deepEqual(lib.map((i) => i.id), ['a', 'b', 'c'], 'input untouched');
});

test('library filter by type and accent-insensitive text', () => {
  assert.deepEqual(sortLibrary(lib, { type: 'movie', sort: 'name' }).map((i) => i.id), ['c', 'a']);
  assert.deepEqual(sortLibrary(lib, { q: 'AMELIE' }).map((i) => i.id), ['c']);
  assert.deepEqual(typeCounts(lib), { all: 3, movie: 2, series: 1 });
  assert.deepEqual(typeCounts(lib, 'a'), { all: 3, movie: 2, series: 1 });
  assert.deepEqual(typeCounts(lib, 'arc'), { all: 1, movie: 0, series: 1 });
  assert.equal(fold(' Élan '), 'elan');
  assert.equal(parseLibrarySort('rating'), 'rating');
  assert.equal(parseLibrarySort('drop table'), 'recent');
});

test('search results: type filter and sorts', () => {
  const r = [
    { id: '1', type: 'movie', year: '1999', rating: '8.7' },
    { id: '2', type: 'series', year: '2021', rating: null },
    { id: '3', type: 'movie', year: '2003', rating: '7.2' },
  ];
  assert.deepEqual(sortResults(r, {}).map((x) => x.id), ['1', '2', '3']);
  assert.deepEqual(sortResults(r, { type: 'movie', sort: 'year' }).map((x) => x.id), ['3', '1']);
  assert.deepEqual(sortResults(r, { sort: 'rating' }).map((x) => x.id), ['1', '3', '2']);
  assert.equal(parseResultSort('year'), 'year');
  assert.equal(parseResultSort(undefined), 'relevance');
});

const catalogs = [
  { type: 'movie', id: 'top', name: 'Popular', genres: ['Action', 'Drama'], genreRequired: false },
  { type: 'movie', id: 'year', name: 'New', genres: ['2026', '2025'], genreRequired: true },
  { type: 'movie', id: 'imdbRating', name: 'Featured', genres: ['Action'], genreRequired: false },
  { type: 'series', id: 'top', name: 'Popular', genres: [], genreRequired: false },
];

test('discover state from URL params', () => {
  let s = discoverState(catalogs, {});
  assert.equal(s.type, 'movie');
  assert.equal(s.catalog?.id, 'top');
  assert.equal(s.genre, '');
  assert.equal(s.byYear, false);
  assert.equal(s.yearCatalog?.id, 'year');

  s = discoverState(catalogs, { catalog: 'year' });
  assert.equal(s.genre, '2026', 'required: first option');
  assert.equal(s.byYear, true);
  assert.equal(s.yearCatalog, null);

  s = discoverState(catalogs, { catalog: 'year', genre: '2025' });
  assert.equal(s.genre, '2025');
  s = discoverState(catalogs, { catalog: 'top', genre: 'Nope' });
  assert.equal(s.genre, '');
  s = discoverState(catalogs, { type: 'series', catalog: 'year' });
  assert.equal(s.catalog?.id, 'top', 'unknown catalog for this type: first one');
  assert.equal(s.yearCatalog, null);
  assert.equal(discoverState([], { type: 'series' }).catalog, null);

  assert.deepEqual(catalogs.map(sortLabel), ['Popularité', 'Année', 'Note', 'Popularité']);
  assert.equal(isYearList(['2020', '1999']), true);
  assert.equal(isYearList([]), false);
});

const ep = (season: number, episode: number, released: string | null = '2008-01-01') => ({ id: `s:${season}:${episode}`, season, episode, released });
const videos = [ep(0, 1), ep(1, 1), ep(1, 2), ep(2, 1), ep(2, 2, '2999-01-01')];
const prog = (videoId: string, watched: boolean, updatedAt: number) => ({ videoId, position: watched ? 1000 : 300, duration: 1000, watched, updatedAt });
const NOW = Date.parse('2026-10-16');

test('next and default episode', () => {
  assert.equal(nextEpisode(videos, videos[2])?.id, 's:2:1', 'crosses seasons');
  assert.equal(nextEpisode(videos, videos[4]), null);
  assert.equal(nextEpisode(videos, videos[0]), null, 'bonus has no next');
  assert.equal(isUpcoming(videos[4], NOW), true);
  assert.equal(isUpcoming(ep(1, 1, null), NOW), false);

  assert.equal(defaultEpisode(videos, [], undefined, NOW)?.id, 's:1:1', 'first regular episode');
  assert.equal(defaultEpisode(videos, [], 's:2:1', NOW)?.id, 's:2:1', 'asked in the URL');
  assert.equal(defaultEpisode(videos, [prog('s:1:2', false, 5), prog('s:1:1', true, 1)], undefined, NOW)?.id, 's:1:2', 'resume');
  assert.equal(defaultEpisode(videos, [prog('s:1:1', false, 1), prog('s:1:2', true, 5)], undefined, NOW)?.id, 's:2:1', 'next after watched');
  assert.equal(defaultEpisode(videos, [prog('s:2:1', true, 5)], undefined, NOW)?.id, 's:2:1', 'next not out yet: stay');
  assert.equal(defaultEpisode([], [], undefined, NOW), null);
});
