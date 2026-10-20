import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { config } from '../src/config.js';
import { newKey } from '../src/encoder.js';
import { registerEncoder } from '../src/encoderRoutes.js';

test('paired apps learn the version to run and download it, others are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-enc-'));
  const exe = Buffer.from('MZ fake windows build');
  writeFileSync(join(dir, 'watchparty-encoder-windows-amd64.exe'), exe);
  writeFileSync(join(dir, 'VERSION'), '1.2.0\n');
  config.encoderDistDir = dir;

  const key = newKey();
  const store = { encoderKey: (id) => (id === key.id ? { uid: 'alice', hash: key.hash, label: 'PC' } : null) };
  const app = Fastify();
  const requireSession = async (request, reply) => reply.code(401).send();
  registerEncoder(app, { store, rooms: [], publish: () => {}, getSession: () => null, requireSession });
  const auth = { authorization: `Bearer ${key.token}` };

  try {
    const latest = await app.inject({ url: '/api/encoder/latest', headers: auth });
    assert.equal(latest.statusCode, 200);
    assert.deepEqual(latest.json(), {
      version: '1.2.0',
      files: { 'watchparty-encoder-windows-amd64.exe': { sha256: createHash('sha256').update(exe).digest('hex') } },
    });
    const file = await app.inject({ url: '/api/encoder/update/watchparty-encoder-windows-amd64.exe', headers: auth });
    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, exe, 'the build as is, no settings inside');

    assert.equal((await app.inject({ url: '/api/encoder/latest' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/encoder/update/watchparty-encoder-windows-amd64.exe', headers: { authorization: 'Bearer wpe_000000000000.' + 'x'.repeat(32) } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/encoder/update/..%2F..%2Fetc%2Fpasswd', headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/encoder/update/VERSION', headers: auth })).statusCode, 404);
  } finally {
    await app.close();
  }
});
