import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { sweepConverters } from '../src/media.js';

test("converters of films no room plays anymore are stopped, the others kept", async () => {
  const destroyed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/hlsv2/status') {
      return res.end(JSON.stringify({
        'wp-old-Sid_1-t-1920': {}, 'wp-old-Sid_1-a0': {}, 'wp-old-Sid_1-c-hevc': {}, 'wp-old-Sid_1-a1r2': {},
        'wp-live-2-t-1280': {}, 'wp-live-2-a1': {}, 'wp-live-2-t-1280r1': {},
        'someone-else': {},
      }));
    }
    const m = /^\/hlsv2\/(.+)\/destroy$/.exec(req.url);
    if (m) destroyed.push(decodeURIComponent(m[1]));
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const before = config.stremioServerUrl;
  config.stremioServerUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const stopped = await sweepConverters(new Set(['live-2']));
    assert.deepEqual(stopped.sort(), ['wp-old-Sid_1-a0', 'wp-old-Sid_1-a1r2', 'wp-old-Sid_1-c-hevc', 'wp-old-Sid_1-t-1920']);
    assert.deepEqual(destroyed.sort(), stopped.sort());
  } finally {
    config.stremioServerUrl = before;
    server.close();
  }
});
