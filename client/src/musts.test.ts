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
