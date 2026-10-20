import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPublicAddress, isPublicHost, safeFetch } from '../src/netguard.js';

const dns = async (host) => ({ 'cdn.example.org': [{ address: '93.184.216.34' }], 'evil.example': [{ address: '10.0.0.5' }], 'mixed.example': [{ address: '8.8.8.8' }, { address: '127.0.0.1' }] })[host] || [];

test('private and local-only addresses are recognised, trailing dots too', () => {
  for (const h of ['localhost', 'localhost.', 'huwa', 'stremio.', 'x.internal.', '127.0.0.1', '10.1.2.3', '172.20.0.2', '192.168.0.1', '169.254.169.254', '100.64.0.1', '[::1]', '::ffff:127.0.0.1', 'fd12::1']) {
    assert.equal(isPublicHost(h), false, h);
  }
  assert.equal(isPublicHost('example.org.'), true);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
});

test('names are judged on what they resolve to', async () => {
  await assertPublicUrl('https://cdn.example.org/f.mkv', { resolve: dns });
  for (const url of ['http://evil.example/', 'http://mixed.example/', 'http://unknown.example/', 'file:///etc/passwd', 'ftp://cdn.example.org/']) {
    await assert.rejects(assertPublicUrl(url, { resolve: dns }), { code: 'PRIVATE_ADDRESS' }, url);
  }
  await assertPublicUrl('http://aiostreams:3000/manifest.json', { resolve: dns, trustedHosts: new Set(['aiostreams']) });
});

test('every redirect is checked before it is followed', async () => {
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url === 'https://cdn.example.org/a') return new Response(null, { status: 302, headers: { location: 'http://evil.example/secret' } });
    return new Response('ok');
  };
  await assert.rejects(safeFetch('https://cdn.example.org/a', {}, { fetchImpl: fake, resolve: dns }), { code: 'PRIVATE_ADDRESS' });
  assert.deepEqual(seen, ['https://cdn.example.org/a'], 'the private address was never fetched');
  const ok = await safeFetch('https://cdn.example.org/b', {}, { fetchImpl: fake, resolve: dns });
  assert.equal(await ok.text(), 'ok');
});
