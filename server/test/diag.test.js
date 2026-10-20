import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAddon } from '../src/diag.js';
import { describeFetchError } from '../src/addons.js';

test('addon URLs are masked (debrid keys never shown)', () => {
  const masked = maskAddon('https://torrentio.strem.fun/realdebrid=SECRETKEY123|language=french');
  assert.equal(masked, 'torrentio.strem.fun/…(39)');
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

test('legal pages render and escape the configured contact', async () => {
  const { contactHtml, privacyPage, termsPage } = await import('../src/legal.js');
  assert.match(termsPage(), /Conditions d’utilisation/);
  assert.match(privacyPage(), /Politique de confidentialité/);
  assert.equal(contactHtml('a@b.fr'), '<a href="mailto:a@b.fr">a@b.fr</a>');
  assert.match(contactHtml('https://discord.gg/abc'), /^<a href="https:\/\/discord\.gg\/abc"/);
  assert.equal(contactHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.match(contactHtml(''), /administrateurs/);
});
