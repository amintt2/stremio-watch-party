import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canResume, episodeCode, parseRoute, pickBest, progressRatio, relativeTime, routeHref } from './format.ts';

test('routes parse and round-trip', () => {
  assert.deepEqual(parseRoute(''), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#/nope'), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#/discover?type=series&genre=Drama'), { name: 'discover', params: { type: 'series', genre: 'Drama' } });
  assert.deepEqual(parseRoute('#/detail/series/tt0903747?video=tt0903747%3A1%3A2'), {
    name: 'detail',
    params: { video: 'tt0903747:1:2', type: 'series', id: 'tt0903747' },
  });
  assert.equal(parseRoute('#/detail/other/tt1').name, 'home');

  const href = routeHref('detail', { type: 'movie', id: 'tt 1', video: null });
  assert.equal(href, '#/detail/movie/tt%201');
  assert.deepEqual(parseRoute(href).params, { type: 'movie', id: 'tt 1' });
  assert.equal(routeHref('home'), '#/');
  assert.equal(routeHref('search', { q: 'la la land' }), '#/search?q=la+la+land');
});

test('progress ratio and resume rules', () => {
  assert.equal(progressRatio(50, 100), 0.5);
  assert.equal(progressRatio(150, 100), 1);
  assert.equal(progressRatio(10, null), 0);
  assert.equal(canResume({ position: 2530, duration: 7000 }), true);
  assert.equal(canResume({ position: 5, duration: 7000 }), false, 'barely started');
  assert.equal(canResume({ position: 6900, duration: 7000 }), false, 'finished');
  assert.equal(canResume({ position: 100, duration: null }), true);
  assert.equal(canResume(null), false);
});

test('labels', () => {
  assert.equal(episodeCode(1, 2), 'S1E02');
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now - 10_000, now), "à l'instant");
  assert.equal(relativeTime(now - 5 * 60_000, now), 'il y a 5 min');
  assert.equal(relativeTime(now - 3 * 3600_000, now), 'il y a 3 h');
  assert.equal(relativeTime(now - 30 * 3600_000, now), 'hier');
});

test('best source: cached, then 1080p, then seeders', () => {
  const s = (quality: string | null, seeders: number | null, cached = false) => ({ quality, seeders, cached });
  assert.equal(pickBest([]), null);
  assert.deepEqual(pickBest([s('4K', 900), s('1080p', 50), s('1080p', 300), s('720p', 2000)]), s('1080p', 300));
  assert.deepEqual(pickBest([s('1080p', 300), s('4K', null, true)]), s('4K', null, true));
  assert.deepEqual(pickBest([s(null, null), s(null, 3)]), s(null, 3));
});
