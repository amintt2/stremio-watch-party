import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferedEnd,
  clampVolume,
  durationLabel,
  formatDelta,
  formatPercent,
  isDoubleTap,
  nextOption,
  parseVolume,
  seekRatio,
  seekTarget,
  shortcutAction,
  tapZone,
  volumeIcon,
  volumeOutput,
} from './controls.ts';

test('volume: clamp, element volume vs Web Audio gain', () => {
  assert.equal(clampVolume(140), 130);
  assert.equal(clampVolume(-3), 0);
  assert.equal(clampVolume(72.6), 73);
  assert.equal(clampVolume(NaN), 100);
  assert.equal(clampVolume(120, 100), 100, 'no Web Audio: 100 % max');

  assert.deepEqual(volumeOutput(80, false, false), { element: 0.8, gain: 1 });
  assert.deepEqual(volumeOutput(130, false, false), { element: 1, gain: 1 }, 'not routed yet: capped');
  assert.deepEqual(volumeOutput(130, false, true), { element: 1, gain: 1.3 });
  assert.deepEqual(volumeOutput(50, false, true), { element: 1, gain: 0.5 });
  assert.deepEqual(volumeOutput(130, true, true), { element: 1, gain: 0 }, 'muted through the gain too');

  assert.equal(volumeIcon(0, false), 'mute');
  assert.equal(volumeIcon(100, true), 'mute');
  assert.equal(volumeIcon(30, false), 'volume-low');
  assert.equal(volumeIcon(130, false), 'volume');
  assert.equal(formatPercent(130), '130 %');

  assert.deepEqual(parseVolume('{"v":125,"m":true}'), { pct: 125, muted: true });
  assert.deepEqual(parseVolume('{"v":999}'), { pct: 130, muted: false });
  assert.deepEqual(parseVolume(null), { pct: 100, muted: false });
  assert.deepEqual(parseVolume('nope'), { pct: 100, muted: false });
});

test('seek bar: pointer ratio, buffered range, labels, targets', () => {
  assert.equal(seekRatio(107, 100, 214, 14), 0, 'thumb centre at the left edge');
  assert.equal(seekRatio(207, 100, 214, 14), 0.5);
  assert.equal(seekRatio(400, 100, 214, 14), 1);
  assert.equal(seekRatio(0, 100, 214, 14), 0);
  assert.equal(seekRatio(10, 0, 10, 14), 0, 'degenerate width');

  const ranges: [number, number][] = [
    [0, 30],
    [60, 95],
  ];
  assert.equal(bufferedEnd(ranges, 12), 30);
  assert.equal(bufferedEnd(ranges, 70), 95);
  assert.equal(bufferedEnd(ranges, 45), 45, 'not buffered here');
  assert.equal(bufferedEnd(ranges, 59.8), 95, 'tolerates a small gap');

  assert.equal(durationLabel(30, 150, false), '2:30');
  assert.equal(durationLabel(30, 150, true), '−2:00');
  assert.equal(durationLabel(200, 150, true), '−0:00');

  assert.equal(seekTarget(5, -10, 100), 0);
  assert.equal(seekTarget(50, 10, 100), 60);
  assert.equal(seekTarget(95, 10, 100), 99, 'never past the end');
  assert.equal(seekTarget(50, 10, 0), 60, 'unknown duration');
  assert.equal(formatDelta(-20), '−20 s');
  assert.equal(formatDelta(10), '+10 s');
});

test('taps: zones and double taps', () => {
  assert.equal(tapZone(10, 300), 'left');
  assert.equal(tapZone(150, 300), 'center');
  assert.equal(tapZone(290, 300), 'right');
  assert.equal(tapZone(10, 0), 'center');

  assert.equal(isDoubleTap(null, { t: 100, x: 10 }, 300), false);
  assert.equal(isDoubleTap({ t: 0, x: 10 }, { t: 200, x: 20 }, 300), true);
  assert.equal(isDoubleTap({ t: 0, x: 280 }, { t: 200, x: 290 }, 300), true);
  assert.equal(isDoubleTap({ t: 0, x: 10 }, { t: 450, x: 20 }, 300), false, 'too slow');
  assert.equal(isDoubleTap({ t: 0, x: 10 }, { t: 200, x: 290 }, 300), false, 'other side');
  assert.equal(isDoubleTap({ t: 0, x: 150 }, { t: 200, x: 150 }, 300), false, 'centre: no seek');
});

test('keyboard shortcuts follow the layout, ignore modifiers', () => {
  assert.equal(shortcutAction({ key: ' ', code: 'Space' }), 'toggle');
  assert.equal(shortcutAction({ key: 'k' }), 'toggle');
  assert.equal(shortcutAction({ key: 'K' }), 'toggle');
  assert.equal(shortcutAction({ key: 'ArrowLeft' }), 'back');
  assert.equal(shortcutAction({ key: 'j' }), 'back');
  assert.equal(shortcutAction({ key: 'l' }), 'forward');
  assert.equal(shortcutAction({ key: 'ArrowUp' }), 'volume-up');
  assert.equal(shortcutAction({ key: 'ArrowDown' }), 'volume-down');
  // AZERTY: the M key sends code "Semicolon".
  assert.equal(shortcutAction({ key: 'm', code: 'Semicolon' }), 'mute');
  assert.equal(shortcutAction({ key: ',', code: 'KeyM' }), null);
  assert.equal(shortcutAction({ key: 'f' }), 'fullscreen');
  assert.equal(shortcutAction({ key: 'c' }), 'subtitles');
  assert.equal(shortcutAction({ key: '?', code: 'Comma' }), 'help');
  assert.equal(shortcutAction({ key: 'Escape' }), 'escape');
  assert.equal(shortcutAction({ key: 'f', ctrlKey: true }), null);
  assert.equal(shortcutAction({ key: 'Tab' }), null);
});

test('subtitle size and menu cycling', () => {
  assert.equal(nextOption(['off', 'f:0', 'x:a'], 'off'), 'f:0');
  assert.equal(nextOption(['off', 'f:0', 'x:a'], 'x:a'), 'off');
  assert.equal(nextOption(['off', 'x:a'], 'gone'), 'off');
  assert.equal(nextOption([], 'off'), 'off');
});
