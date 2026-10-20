import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meets, mustsLabel } from './musts.ts';

const src = (languages: string[], quality: string | null, cached = false) => ({ languages, quality, cached });

test('obligations filter the sources, all of them together', () => {
  assert.equal(meets(src(['MULTI'], '1080p'), ['multi', 'vf', 'stfr', 'hd']), true);
  assert.equal(meets(src(['VF'], '1080p'), ['multi']), false);
  assert.equal(meets(src(['VF'], '720p'), ['vf']), true);
  assert.equal(meets(src(['VF'], '720p'), ['vf', 'hd']), false);
  assert.equal(meets(src(['VOSTFR'], '4K'), ['stfr', 'uhd']), true);
  assert.equal(meets(src([], '4K'), ['stfr']), false);
  assert.equal(meets(src([], '1080p', true), ['debrid']), true);
  assert.equal(meets(src([], null), []), true, 'no obligation: everything goes');
});

test('the message names them in the row order', () => {
  assert.equal(mustsLabel(['hd', 'multi']), 'VF + VO, 1080p+');
});

test('the defaults line comes from the last choices made in the player', async () => {
  const { launchPrefs } = await import('./musts.ts');
  const store: Record<string, string> = { 'wp-audio': 'vo', 'wp-subs': 'fr', 'wp-quality': '1080' };
  assert.equal(launchPrefs((k) => store[k] ?? null), 'VO · sous-titres français · 1080p');
  assert.equal(launchPrefs(() => null), 'audio du fichier · sans sous-titres · qualité auto');
  assert.equal(launchPrefs((k) => ({ ...store, 'wp-audio-lang': 'en' })[k] ?? null), 'VO anglais · sous-titres français · 1080p');
});
