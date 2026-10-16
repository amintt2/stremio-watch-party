import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addonBase } from '../src/config.js';

test('addon URLs are normalized from manifest, stremio:// and share links', () => {
  const base = 'https://torrentio.strem.fun/language=french';
  assert.equal(addonBase('https://torrentio.strem.fun/language=french/manifest.json'), base);
  assert.equal(addonBase('stremio://torrentio.strem.fun/language=french/manifest.json'), base);
  assert.equal(
    addonBase(
      'https://app.strem.io/shell-v4.4/#/addons/community/all?addon=https%3A%2F%2Ftorrentio.strem.fun%2Flanguage%3Dfrench%2Fmanifest.json'
    ),
    base
  );
  assert.equal(addonBase(' https://v3-cinemeta.strem.io/manifest.json/ '), 'https://v3-cinemeta.strem.io');
});
