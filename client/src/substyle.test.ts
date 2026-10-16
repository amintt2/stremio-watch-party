import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STYLE, pictureHeight, sanitizeStyle, styleVars, textShadow } from './substyle.ts';
import { cleanVttText, formatOffset } from './subtitles.ts';
import { shortcutAction } from './controls.ts';

test('saved style is checked field by field', () => {
  assert.deepEqual(sanitizeStyle(null), DEFAULT_STYLE);
  const s = sanitizeStyle({ font: 'comic', size: 9, color: 'red', outline: 4, background: 'band', bgOpacity: 2, bold: false, position: 3 });
  assert.equal(s.font, 'comic');
  assert.equal(s.size, DEFAULT_STYLE.size, 'out of range');
  assert.equal(s.color, DEFAULT_STYLE.color, 'not a #RRGGBB colour');
  assert.equal(s.outline, 4);
  assert.equal(s.background, 'band');
  assert.equal(s.bgOpacity, DEFAULT_STYLE.bgOpacity);
  assert.equal(s.bold, false);
  assert.equal(s.position, 3);
});

test('sizes follow the picture height, letterbox included', () => {
  // 16:9 film in a 1000×1000 box: 562.5 px of picture, bars of 218.75 px.
  const h = pictureHeight(1000, 1000, 1920, 1080);
  assert.equal(h, 562.5);
  const v = styleVars({ ...DEFAULT_STYLE, size: 2, position: 1, background: 'box', bgOpacity: 0.5 }, h, 1000);
  assert.equal(v['--subs-size'], '29.3px');
  assert.equal(v['--subs-bottom'], `${(218.75 + 562.5 * 0.06).toFixed(1)}px`);
  assert.equal(v['--subs-box'], 'rgba(0, 0, 0, 0.5)');
  assert.equal(v['--subs-band'], 'transparent');
  assert.equal(styleVars(DEFAULT_STYLE, 100)['--subs-size'], '12.0px', 'floor for tiny players');
  assert.equal(pictureHeight(800, 450, 0, 0), 450, 'unknown video size');
});

test('outline is a ring of shadows, then the drop shadow', () => {
  assert.equal(textShadow(0, '#000000', 0), 'none');
  const ring = textShadow(2, '#000000', 1).split(/, (?![^(]*\))/);
  assert.equal(ring.length, 8 + 1 + 1);
  assert.ok(ring.at(-1)!.includes('rgba(0, 0, 0, 0.85)'));
});

test('cues from the file: same safe subset as the server', () => {
  assert.equal(cleanVttText('<c.yellow>Salut</c> <i.x>toi</i>\n<script>x</script>&amp; <b>a</b>'), 'Salut <i>toi</i>\nx&amp; <b>a</b>');
  assert.equal(cleanVttText('a &lt;b&gt; c'), 'a &lt;b&gt; c');
});

test('offsets in French, shortcuts G / H', () => {
  assert.equal(formatOffset(1.5), '+1,5 s');
  assert.equal(formatOffset(-0.25), '−0,25 s');
  assert.equal(formatOffset(0), '0 s');
  assert.equal(shortcutAction({ key: 'g' }), 'subs-earlier');
  assert.equal(shortcutAction({ key: 'H' }), 'subs-later');
});
