import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableQualities,
  converterParams,
  isAllowedHlsPath,
  parseProfile,
  rewritePlaylist,
} from '../src/media.js';
import { describeStream } from '../src/addons.js';

const hevc4k = { video: { codec: 'hevc', width: 3840, height: 2160, hdr: true } };
const h264p1080 = { video: { codec: 'h264', width: 1920, height: 1080 } };

test('4K HEVC is copied for HEVC-capable viewers at 4K', () => {
  const p = converterParams('s', hevc4k, '2160', { hevc: true });
  assert.equal(p.mode, 'copy');
  assert.equal(p.convertId, 'wp-s-c-hevc');
  assert.deepEqual(p.query.getAll('videoCodecs'), ['hevc']);
  assert.equal(p.query.get('maxWidth'), null);
});

test('4K HEVC is transcoded to H.264 for other viewers', () => {
  const p = converterParams('s', hevc4k, '2160', { hevc: false });
  assert.equal(p.mode, 'transcode');
  assert.equal(p.convertId, 'wp-s-t-3840');
  assert.equal(p.query.get('forceTranscoding'), '1');
});

test('lower qualities force a downscale even when the codec is playable', () => {
  const p = converterParams('s', h264p1080, '720', {});
  assert.equal(p.mode, 'transcode');
  assert.equal(p.query.get('maxWidth'), '1280');
  assert.equal(p.outputWidth, 1280);
});

test('profiles that resolve to the same output share one converter', () => {
  const a = converterParams('s', h264p1080, '1080', { hevc: true });
  const b = converterParams('s', h264p1080, '2160', { hevc: false });
  assert.equal(a.convertId, b.convertId);
  assert.equal(a.mode, 'copy');
});

test('audio is always made browser-safe', () => {
  const p = converterParams('s', h264p1080, '1080', {});
  assert.deepEqual(p.query.getAll('audioCodecs'), ['aac', 'mp3']);
  assert.equal(p.query.get('maxAudioChannels'), '2');
});

test('unknown quality is rejected', () => {
  assert.equal(converterParams('s', h264p1080, '999', {}), null);
});

test('quality ladder never goes above the source', () => {
  assert.deepEqual(availableQualities(h264p1080).map((q) => q.id), ['1080', '720', '480']);
  assert.deepEqual(availableQualities(hevc4k).map((q) => q.id), ['2160', '1080', '720', '480']);
  assert.deepEqual(
    availableQualities({ video: { codec: 'h264', width: 1600 } }).map((q) => q.id),
    ['1080', '720', '480']
  );
  assert.deepEqual(availableQualities({ video: { codec: 'h264', width: 640 } }).map((q) => q.id), ['480']);
});

test('playlist rewrite removes the internal query (mediaURL) everywhere', () => {
  const q = '?mediaURL=http%3A%2F%2F127.0.0.1%3A11470%2Fabc%2F0&videoCodecs=h264';
  const input = [
    '#EXTM3U',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="0",DEFAULT=YES,URI="audio0.m3u8${q}"`,
    `#EXT-X-MAP:URI="video0/init.mp4${q}"`,
    '#EXTINF:4.000000,',
    `video0/segment1.m4s${q}`,
    '',
  ].join('\n');
  const out = rewritePlaylist(input);
  assert.ok(!out.includes('mediaURL'));
  assert.ok(out.includes('URI="audio0.m3u8"'));
  assert.ok(out.includes('URI="video0/init.mp4"'));
  assert.ok(out.includes('\nvideo0/segment1.m4s\n'));
});

test('relay only accepts converter resources', () => {
  for (const ok of [
    'master.m3u8',
    'video0.m3u8',
    'audio1.m3u8',
    'subtitle2.m3u8',
    'video0/init.mp4',
    'audio0/segment12.m4s',
    'subtitle0/segment3.vtt',
  ]) {
    assert.ok(isAllowedHlsPath(ok), ok);
  }
  for (const bad of ['../settings', 'master.m3u8/../../x', 'video0/segment1.ts', 'probe', '']) {
    assert.ok(!isAllowedHlsPath(bad), bad);
  }
});

test('Torrentio-style stream descriptions are parsed', () => {
  const d = describeStream(
    {
      name: 'Torrentio\n4k HDR',
      title: 'Movie.2023.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1-GRP\n👤 612 💾 58.3 GB ⚙️ ThePirateBay',
      infoHash: 'a'.repeat(40),
      fileIdx: 0,
    },
    'Torrentio'
  );
  assert.equal(d.seeders, 612);
  assert.equal(d.size, '58.3 GB');
  assert.equal(d.origin, 'ThePirateBay');
  assert.equal(d.quality, '4K');
  assert.equal(d.hdr, true);
  assert.equal(d.hevc, true);
  assert.equal(d.kind, 'torrent');
  assert.equal(d.release, 'Movie.2023.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1-GRP');
  assert.ok(!JSON.stringify(d).includes('aaaa'), 'no infoHash leaks to the browser');
});

test('debrid links are flagged as cached and keep their URL private', () => {
  const d = describeStream(
    { name: '[RD+] Torrentio\n1080p', title: 'Show.S01E01.1080p\n👤 50', url: 'https://x/realdebrid/SECRET/f.mkv' },
    'Torrentio'
  );
  assert.equal(d.cached, true);
  assert.equal(d.kind, 'http');
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});

test('profile segment parsing', () => {
  assert.deepEqual(parseProfile('1080'), { quality: '1080', caps: {} });
  assert.deepEqual(parseProfile('2160hvo'), { quality: '2160', caps: { hevc: true, vp9: true, opus: true } });
  assert.equal(parseProfile('1080x'), null);
  assert.equal(parseProfile('../1080'), null);
});

test('VP9/Opus sources are copied for viewers that support them', () => {
  const vp9 = { video: { codec: 'vp9', width: 1920 } };
  const p = converterParams('s', vp9, '1080', { vp9: true, opus: true });
  assert.equal(p.mode, 'copy');
  assert.equal(p.convertId, 'wp-s-c-vp9-o');
  assert.ok(p.query.getAll('audioCodecs').includes('opus'));
  assert.equal(converterParams('s', vp9, '1080', {}).mode, 'transcode');
});
