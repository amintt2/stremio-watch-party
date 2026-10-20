import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableQualities,
  checkFileSize,
  chooseFile,
  formatGb,
  converterParams,
  createBody,
  ensureFileHash,
  fileFromInfo,
  fileFromStream,
  opensubtitlesHash,
  hlsParams,
  torrentHealth,
  isAllowedHlsPath,
  parseProfile,
  wantedSettings,
  peerSources,
  rewritePlaylist,
} from '../src/media.js';
import http from 'node:http';
import { describeStream, parseSize, streamLanguages, tooBigForServer } from '../src/addons.js';

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
  assert.deepEqual(parseProfile('2160hv'), { quality: '2160', caps: { hevc: true, vp9: true } });
  assert.equal(parseProfile('1080x'), null);
  assert.equal(parseProfile('../1080'), null);
});

test('VP9 sources are copied for viewers that support them', () => {
  const vp9 = { video: { codec: 'vp9', width: 1920 } };
  const p = converterParams('s', vp9, '1080', { vp9: true });
  assert.equal(p.mode, 'copy');
  assert.equal(p.convertId, 'wp-s-c-vp9');
  assert.equal(converterParams('s', vp9, '1080', {}).mode, 'transcode');
});

test('Stremio server tuning only asks for what is missing', () => {
  assert.deepEqual(wantedSettings({ transcodeConcurrency: 1, cacheSize: 5 * 1024 ** 3 }), { transcodeConcurrency: 8 });
  assert.deepEqual(wantedSettings({ transcodeConcurrency: 8, cacheSize: null }), {});
});

test('ten viewers on every quality need at most 5 converters per media', () => {
  const hevc4kInfo = { video: { codec: 'hevc', width: 3840 } };
  const ids = new Set();
  for (const quality of ['2160', '1080', '720', '480']) {
    for (const caps of [{}, { hevc: true }, { av1: true, vp9: true }, { hevc: true, vp9: true }]) {
      ids.add(converterParams('s', hevc4kInfo, quality, caps).convertId);
    }
  }
  assert.equal(ids.size, 5);
});

test('torrents without trackers get DHT plus public trackers', () => {
  const own = peerSources({ infoHash: 'A'.repeat(40), sources: ['tracker:udp://x:1/announce'] });
  assert.deepEqual(own, ['tracker:udp://x:1/announce']);
  const fallback = peerSources({ infoHash: 'A'.repeat(40) });
  assert.equal(fallback[0], `dht:${'a'.repeat(40)}`);
  assert.ok(fallback.length > 3 && fallback.slice(1).every((s) => s.startsWith('tracker:udp://')));
});

const hevc4kBase = hevc4k;
test('each audio track has its own converter, shared by every viewer of that track', () => {
  const hevc4k = { ...hevc4kBase, audio: [{ codec: 'eac3' }, { codec: 'aac' }] };
  assert.equal(hlsParams('s', hevc4k, '1080', {}, 'audio2.m3u8'), null, 'no converter for a track the file does not have');
  const vf = hlsParams('s', hevc4k, '1080', { hevc: false }, 'audio0/segment3.m4s');
  const vo = hlsParams('s', hevc4k, '2160', { hevc: true }, 'audio1.m3u8');
  const vfOther = hlsParams('s', hevc4k, '720', {}, 'audio0/init.mp4');
  assert.equal(vf.convertId, 'wp-s-a0');
  assert.equal(vo.convertId, 'wp-s-a1');
  assert.equal(vfOther.convertId, vf.convertId, 'same track, any quality: one converter');
  assert.equal(vf.query.toString(), vfOther.query.toString());
  assert.equal(vf.query.get('forceTranscoding'), null, 'never touches the video');
  assert.deepEqual(vf.query.getAll('audioCodecs'), ['aac', 'mp3']);
  // Video and master playlists still come from the quality converter.
  assert.equal(hlsParams('s', hevc4k, '1080', {}, 'master.m3u8').convertId, 'wp-s-t-1920');
  assert.equal(hlsParams('s', hevc4k, '1080', {}, 'video0/segment1.m4s').convertId, 'wp-s-t-1920');
  assert.equal(hlsParams('s', hevc4k, '999', {}, 'audio0.m3u8'), null);
});


test('source languages come from the release name', () => {
  assert.deepEqual(streamLanguages('Dune.2021.MULTi.VFF.2160p.WEB'), ['MULTI', 'VF']);
  assert.deepEqual(streamLanguages('Dune.2021.FRENCH.1080p'), ['VF']);
  assert.deepEqual(streamLanguages('Dune 2021 VOSTFR 1080p'), ['VOSTFR']);
  assert.deepEqual(streamLanguages('Dune.2021.1080p.BluRay\n🇬🇧 / 🇫🇷'), ['VF']);
  assert.deepEqual(streamLanguages('Dune.2021.Dual.Audio.1080p'), [], 'dual audio: usually English + another, not French');
  assert.deepEqual(streamLanguages('Dune.2021.Dual.Audio.FRENCH.1080p'), ['MULTI', 'VF']);
  // Indian "multi audio" releases: no French in them.
  assert.deepEqual(streamLanguages('RRR.2022.1080p.WEB-DL.Multi.Audio.[Hindi.Tamil.Telugu.Kannada.Malayalam.English]'), []);
  assert.deepEqual(streamLanguages('Film 2023 MULTi 1080p\n🇮🇳 / 🇬🇧'), [], 'flags without the French one');
  assert.deepEqual(streamLanguages('Film 2023 MULTi 1080p\n🇫🇷 / 🇬🇧'), ['MULTI', 'VF']);
  assert.deepEqual(streamLanguages('Film.2023.MULTi.1080p.WEB'), ['MULTI'], 'French scene MULTi');
  assert.deepEqual(streamLanguages('Dune.2021.1080p.BluRay.x264'), []);
  assert.deepEqual(streamLanguages('Frenchie.2021.1080p'), [], 'word boundaries');
  assert.deepEqual(describeStream({ name: 'X\n1080p', title: 'Film.MULTi.1080p' }, 'a').languages, ['MULTI']);
});

test('torrent create body follows the Stremio protocol (Stremio and Huwa engines)', () => {
  const ih = 'A'.repeat(40);
  const b = createBody({ infoHash: ih });
  assert.equal(b.torrent.infoHash, 'a'.repeat(40));
  assert.deepEqual(b.guessFileIdx, {});
  assert.ok(b.peerSearch.sources.some((s) => s.startsWith('tracker:')), 'public trackers when the addon gives none');
  assert.equal(createBody({ infoHash: ih, fileIdx: 3 }).guessFileIdx, undefined);
  assert.deepEqual(createBody({ infoHash: ih, sources: ['tracker:udp://x:1'] }).peerSearch.sources, ['tracker:udp://x:1']);
});

test('file choice: addon fileIdx, then engine guess, then largest file', () => {
  const files = [{ length: 10 }, { length: 900 }, { length: 50 }];
  assert.equal(chooseFile({ fileIdx: 2 }, { guessedFileIdx: 1, files }), 2);
  assert.equal(chooseFile({}, { guessedFileIdx: 0, files }), 0);
  assert.equal(chooseFile({}, { guessedFileIdx: null, files }), 1);
  assert.equal(chooseFile({}, {}), null);
});

test('torrent health from stats.json: peers and speed vs the stream bitrate', () => {
  const bitrate = 8_000_000; // 1 MB/s needed
  assert.equal(torrentHealth({ peers: 12, downloadSpeed: 3e6, streamProgress: 0.2 }, bitrate).level, 'ok');
  assert.equal(torrentHealth({ peers: 2, downloadSpeed: 4e5, streamProgress: 0.2 }, bitrate).level, 'slow');
  assert.equal(torrentHealth({ peers: 0, peerSearchRunning: true }, bitrate).level, 'searching');
  assert.equal(torrentHealth({ peers: 0, peerSearchRunning: false }, bitrate).level, 'stalled');
  assert.equal(torrentHealth({ peers: 0, streamProgress: 1 }, bitrate).level, 'done');
  assert.equal(torrentHealth({ peers: 5, downloadSpeed: 1 }, null).level, 'ok', 'unknown bitrate: no slow verdict');
  assert.equal(torrentHealth(null, bitrate), null);
  assert.equal(torrentHealth({ peers: 3, downloadSpeed: 2e6 }, bitrate).neededSpeed, 1e6);
});

test('server storage: sizes parsed, oversized torrents flagged and refused', () => {
  const GB = 1024 ** 3;
  assert.equal(parseSize('💾 1.5 GB'), 1.5 * GB);
  assert.equal(parseSize('700 MiB'), 700 * 1024 ** 2);
  assert.equal(parseSize('58,3 GB'), Math.round(58.3 * GB));
  assert.equal(parseSize('?'), null);

  const max = 15 * GB;
  assert.equal(tooBigForServer({ infoHash: 'x' }, 60 * GB, max), true);
  assert.equal(tooBigForServer({ infoHash: 'x' }, 2 * GB, max), false);
  assert.equal(tooBigForServer({ url: 'https://debrid/x' }, 60 * GB, max), false, 'debrid uses no disk');
  assert.equal(tooBigForServer({ infoHash: 'x' }, null, max), false, 'unknown size: checked after create');
  assert.equal(tooBigForServer({ infoHash: 'x' }, 60 * GB, null), false, 'no limit configured');

  const info = { files: [{ length: 2 * GB }, { length: 60 * GB }] };
  assert.doesNotThrow(() => checkFileSize(info, 0, max));
  assert.throws(() => checkFileSize(info, 1, max), (e) => e.final && /de 60 Go.*max 15 Go/.test(e.message));
  assert.equal(formatGb(10737418), '0,01');
  assert.equal(formatGb(1.5 * GB), '1,5');
  assert.doesNotThrow(() => checkFileSize(info, 1, null));
});

test('OpenSubtitles hash: size + first and last 64 KiB as little-endian words', async () => {
  const size = 200000;
  const data = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) % 256);
  // Reference value computed independently (Python struct '<Q').
  assert.equal(opensubtitlesHash(data.subarray(0, 65536), data.subarray(size - 65536), size), '60a0df1f5fa2cd40');

  // Same value read over HTTP with two Range requests.
  const server = http.createServer((req, res) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${size}` });
    res.end(data.subarray(+a, +b + 1));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const session = { mediaURL: `http://127.0.0.1:${server.address().port}/f`, file: { name: 'x.mkv', size: null, hash: null } };
    const file = await ensureFileHash(session);
    assert.deepEqual(file, { name: 'x.mkv', size, hash: '60a0df1f5fa2cd40' });
  } finally {
    server.close();
  }
});

test('played file name and size, from the torrent or the addon hints', () => {
  assert.deepEqual(fileFromInfo({ files: [{ name: 'a.nfo', length: 10 }, { path: 'Dir/Film.2024.1080p.mkv', length: 5e9 }] }, 1), { name: 'Film.2024.1080p.mkv', size: 5e9 });
  assert.deepEqual(fileFromInfo(null, 0), { name: null, size: null });
  assert.deepEqual(
    fileFromStream({ behaviorHints: { filename: 'Show.S01E01.mkv', videoSize: 123, videoHash: 'ABCDEF0123456789' } }, 'https://cdn/x'),
    { name: 'Show.S01E01.mkv', size: 123, hash: 'abcdef0123456789' }
  );
  assert.deepEqual(fileFromStream({}, 'https://cdn/dl/Film%202024.mp4?token=1'), { name: 'Film 2024.mp4', size: null, hash: null });
  assert.deepEqual(fileFromStream({ behaviorHints: { videoHash: 'nope' } }, 'https://cdn/resolve/abc'), { name: null, size: null, hash: null });
});
