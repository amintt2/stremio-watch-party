import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAddon } from '../src/diag.js';
import { describeFetchError } from '../src/addons.js';

test('addon URLs are masked (debrid keys never shown)', () => {
  const masked = maskAddon('https://torrentio.strem.fun/realdebrid=SECRETKEY123|language=french');
  assert.ok(masked.startsWith('torrentio.strem.fun/real…'));
  assert.ok(!masked.includes('SECRET'));
  assert.equal(maskAddon('https://v3-cinemeta.strem.io'), 'v3-cinemeta.strem.io');
  assert.equal(maskAddon('not a url'), 'URL invalide');
});

test('fetch errors are described with their cause', () => {
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  assert.equal(describeFetchError(timeout, 15000), 'timeout after 15 s');
  const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' } });
  assert.equal(describeFetchError(dns, 1000), 'ENOTFOUND: getaddrinfo ENOTFOUND x');
});
