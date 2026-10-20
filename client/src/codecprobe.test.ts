import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpectedColour, outputOf } from './codecprobe.ts';

test('copy only what this device decodes, and only when it fits the quality', () => {
  const caps = { hevc: true, av1: false, vp9: false };
  assert.deepEqual(outputOf({ codec: 'hevc', width: 3840 }, 3840, caps), { mode: 'copy', codec: 'hevc' });
  assert.deepEqual(outputOf({ codec: 'hevc', width: 3840 }, 1920, caps), { mode: 'transcode', codec: 'h264' });
  assert.deepEqual(outputOf({ codec: 'av1', width: 1920 }, 1920, caps), { mode: 'transcode', codec: 'h264' });
  assert.deepEqual(outputOf({ codec: 'h264', width: 1920 }, 1920, { hevc: false, av1: false, vp9: false }), { mode: 'copy', codec: 'h264' });
  assert.deepEqual(outputOf({ codec: 'mpeg4', width: 720 }, 1920, caps), { mode: 'transcode', codec: 'h264' });
});

test('the sample colour survives YUV → RGB, a black picture does not', () => {
  assert.equal(isExpectedColour([209, 77, 118]), true);
  assert.equal(isExpectedColour([196, 59, 120]), true);
  assert.equal(isExpectedColour([0, 0, 0]), false);
  assert.equal(isExpectedColour([16, 16, 16]), false);
});
