import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignToReference, alignToSpeech, cueMask, fpsRatio, toCue, toVideo, type Cue } from './subsync.ts';

// Deterministic pseudo-random numbers.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Dialogue-like lines: 1–5 s long, 0.3–8 s apart, over `duration` seconds. */
function dialogue(duration: number, seed = 1): Cue[] {
  const r = rng(seed);
  const cues: Cue[] = [];
  let t = 5;
  while (t < duration) {
    const len = 1 + r() * 4;
    cues.push({ start: t, end: t + len });
    t += len + 0.3 + r() * (r() < 0.2 ? 25 : 6);
  }
  return cues;
}

test('timing helpers are inverse of each other', () => {
  const timing = { offset: 2.5, ratio: 25 / 23.976 };
  assert.ok(Math.abs(toCue(toVideo(100, timing), timing) - 100) < 1e-9);
  assert.deepEqual([...cueMask([{ start: 1, end: 2 }, { start: 3, end: 30 }], 0.5, 8)], [0, 0, 1, 1, 0, 0, 0, 0]);
});

test('aligns a subtitle on a reference timed for the file (shift + frame rate)', () => {
  const truth = dialogue(5400);
  // The other language: same moments, slightly different cuts, 25 fps release, 3.2 s late.
  const r = rng(7);
  const ratio = 23.976 / 25;
  const other = truth
    .filter(() => r() > 0.1)
    .map((c) => ({ start: (c.start - 3.2) / ratio + (r() - 0.5) * 0.3, end: (c.end - 3.2) / ratio + (r() - 0.5) * 0.3 }));
  const result = alignToReference(other, truth);
  assert.ok(result, 'found');
  assert.ok(Math.abs(result.ratio - ratio) < 1e-6, `ratio ${result.ratio}`);
  // Line k of `other` must land where it really is.
  const probe = other[200];
  const real = toVideo(probe.start, result);
  assert.ok(Math.abs(real - (probe.start * ratio + 3.2)) < 0.35, `landed ${real}`);
});

test('reference unrelated to the subtitle: no answer rather than a wrong one', () => {
  assert.equal(alignToReference(dialogue(3000, 3), dialogue(3000, 99)), null);
});

test('aligns on the measured voice energy of the part already watched', () => {
  const cues = dialogue(3000, 5);
  const shift = -2.4; // the file's lines come 2.4 s early
  const step = 0.1;
  const r = rng(11);
  const samples = new Map<number, number>();
  // 6 minutes heard, from 10:00: voice where the lines really are, noise and music elsewhere.
  for (let i = 6000; i < 6000 + 3600; i++) {
    const t = i * step;
    const speaking = cues.some((c) => t >= c.start - shift && t < c.end - shift);
    const music = Math.sin(t / 7) > 0.6 ? 0.8 : 0;
    samples.set(i, (speaking ? 1 : 0) * (0.5 + r()) + music * r() + r() * 0.6);
  }
  const result = alignToSpeech(cues, samples, step, { offset: 0, ratio: 1 });
  assert.ok(result, 'found');
  assert.ok(Math.abs(result.offset - -shift) < 0.25, `offset ${result.offset}`);

  // Pure noise: nothing applied.
  const noise = new Map<number, number>();
  for (let i = 6000; i < 9600; i++) noise.set(i, r());
  assert.equal(alignToSpeech(cues, noise, step, { offset: 0, ratio: 1 }), null);
});

test('frame-rate hint only for the known conversions', () => {
  assert.ok(Math.abs(fpsRatio(25, 23.976) - 25 / 23.976) < 1e-9);
  assert.equal(fpsRatio(23.976, 23.976), 1);
  assert.equal(fpsRatio(24, 23.976), 1, '24 often means 23.976');
  assert.equal(fpsRatio(30, 23.976), 1);
  assert.equal(fpsRatio(null, 24), 1);
});
