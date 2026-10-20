import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeCues,
  canResume,
  episodeCode,
  langCode,
  languageName,
  parseRoute,
  pickAudioTrack,
  pickBest,
  progressRatio,
  relativeTime,
  routeHref,
} from './format.ts';

test('routes parse and round-trip', () => {
  assert.deepEqual(parseRoute(''), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#/nope'), { name: 'notfound', params: {} });
  assert.deepEqual(parseRoute('#/'), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#'), { name: 'home', params: {} });
  assert.deepEqual(parseRoute('#/discover?type=series&genre=Drama'), { name: 'discover', params: { type: 'series', genre: 'Drama' } });
  assert.deepEqual(parseRoute('#/detail/series/tt0903747?video=tt0903747%3A1%3A2'), {
    name: 'detail',
    params: { video: 'tt0903747:1:2', type: 'series', id: 'tt0903747' },
  });
  assert.equal(parseRoute('#/detail/other/tt1').name, 'notfound');
  assert.equal(parseRoute('#/detail/movie').name, 'notfound');

  const href = routeHref('detail', { type: 'movie', id: 'tt 1', video: null });
  assert.equal(href, '#/detail/movie/tt%201');
  assert.deepEqual(parseRoute(href).params, { type: 'movie', id: 'tt 1' });
  assert.equal(routeHref('home'), '#/');
  assert.equal(routeHref('search', { q: 'la la land' }), '#/search?q=la+la+land');
  // "type" is a filter outside title pages (was dropped: Films/Séries switches did nothing).
  assert.equal(routeHref('discover', { type: 'series', catalog: 'top', genre: '' }), '#/discover?type=series&catalog=top');
  assert.deepEqual(parseRoute(routeHref('library', { type: 'movie', sort: 'name' })).params, { type: 'movie', sort: 'name' });
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

test('best source prefers MULTI (VF + VO) so everyone can pick their language', () => {
  const multi = { quality: '720p', seeders: 5, cached: false, languages: ['MULTI', 'VF'] };
  const vf = { quality: '1080p', seeders: 900, cached: true, languages: ['VF'] };
  assert.equal(pickBest([vf, multi]), multi);
  assert.equal(pickBest([vf]), vf);
});

test('language codes and names', () => {
  assert.equal(langCode('fre'), 'fr');
  assert.equal(langCode('fr-FR'), 'fr');
  assert.equal(langCode('pob'), 'pb');
  assert.equal(languageName('eng'), 'Anglais');
  assert.equal(languageName('xyz'), 'XYZ');
  assert.equal(languageName(null), 'Inconnu');
});

test('active cues at a time, overlaps included', () => {
  const cues = [
    { start: 1, end: 4, text: 'a' },
    { start: 3, end: 5, text: 'b' },
    { start: 10, end: 12, text: 'c' },
  ];
  assert.deepEqual(activeCues(cues, 0).map((c) => c.text), []);
  assert.deepEqual(activeCues(cues, 3.5).map((c) => c.text), ['a', 'b']);
  assert.deepEqual(activeCues(cues, 4.5).map((c) => c.text), ['b']);
  assert.deepEqual(activeCues(cues, 7).map((c) => c.text), []);
  assert.deepEqual(activeCues(cues, 11).map((c) => c.text), ['c']);
  assert.deepEqual(activeCues([], 3), []);
});

test('audio preference: VF or VO per viewer', () => {
  const tracks = [{ lang: 'fre', name: 'Français' }, { lang: 'eng', name: 'English' }];
  assert.equal(pickAudioTrack(tracks, 'fr'), 0);
  assert.equal(pickAudioTrack(tracks, 'vo'), 1);
  assert.equal(pickAudioTrack([tracks[1], tracks[0]], 'fr'), 1);
  assert.equal(pickAudioTrack([{ name: 'VFF 5.1' }, { name: 'Original' }], 'fr'), 0);
  assert.equal(pickAudioTrack(tracks, null), null);
  assert.equal(pickAudioTrack([tracks[1]], 'fr'), null, 'single track: nothing to choose');
  assert.equal(pickAudioTrack([{ lang: 'eng' }, { lang: 'jpn' }], 'fr'), null);
});

test('audio chip labels: VF, language codes, else A1/A2', async () => {
  const { audioChipLabel } = await import('./format.ts');
  assert.equal(audioChipLabel({ lang: 'fre', name: 'Français' }, 0), 'VF');
  assert.equal(audioChipLabel({ lang: 'eng' }, 1), 'EN');
  assert.equal(audioChipLabel({ lang: 'und', name: 'Japanese 5.1' }, 1), 'JA');
  assert.equal(audioChipLabel({ name: 'VFF AC3' }, 0), 'VF');
  assert.equal(audioChipLabel({}, 2), 'A3');
});

test('the exact language chosen last time wins over "VO" (English, not the first original track)', () => {
  const tracks = [{ lang: 'hin', name: 'Hindi' }, { lang: 'eng', name: 'English' }, { lang: 'fre', name: 'Français' }];
  assert.equal(pickAudioTrack(tracks, 'vo'), 0, 'VO alone: the first non-French track');
  assert.equal(pickAudioTrack(tracks, 'vo', 'en'), 1);
  assert.equal(pickAudioTrack(tracks, 'fr', 'de'), 2, 'language not in this film: back to VF / VO');
  assert.equal(pickAudioTrack(tracks, null, null), null);
});
