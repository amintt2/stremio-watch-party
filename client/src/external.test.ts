import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  androidIntent,
  detectPlatform,
  externalOptions,
  infuseUrl,
  m3uPlaylist,
  nativeHref,
  nplayerUrl,
  outplayerUrl,
  playlistName,
  vlcIosUrl,
  type ExternalFile,
} from './external.ts';

const file: ExternalFile = {
  url: 'https://watch.example/api/media/abc/file/dG9r.123.sig/The%20Matrix.mkv',
  name: 'The Matrix.mkv',
  title: 'Matrix · VF',
  position: 754.6,
};

test('platform from the user agent', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'), 'android');
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Discord/240.0'), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5), 'ios', 'iPadOS');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 0), 'desktop');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) discord/1.0.9 Chrome/124'), 'desktop');
});

test('Android intents: VLC (long position), MX Player (int position), chooser', () => {
  assert.equal(
    androidIntent(file, 'org.videolan.vlc', 'l'),
    'intent://watch.example/api/media/abc/file/dG9r.123.sig/The%20Matrix.mkv#Intent;scheme=https;action=android.intent.action.VIEW;type=video/*;package=org.videolan.vlc;S.title=Matrix%20%C2%B7%20VF;l.position=754600;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dorg.videolan.vlc;end'
  );
  const mx = nativeHref('mx', 'android', file)!;
  assert.match(mx, /;package=com\.mxtech\.videoplayer\.ad;/);
  assert.match(mx, /;i\.position=754600;/);
  assert.match(nativeHref('mx-pro', 'android', file)!, /;package=com\.mxtech\.videoplayer\.pro;/);
  const chooser = nativeHref('chooser', 'android', file)!;
  assert.ok(!chooser.includes('package='), 'no package: system chooser');
  assert.ok(!chooser.includes('browser_fallback_url'));
  assert.ok(!androidIntent({ ...file, position: 0 }, 'org.videolan.vlc').includes('position'), 'no position at 0');
  assert.match(androidIntent({ ...file, url: 'http://localhost:3501/f/x.mkv' }, null), /^intent:\/\/localhost:3501\/f\/x\.mkv#Intent;scheme=http;/);
});

test('iOS player links', () => {
  const enc = encodeURIComponent(file.url);
  assert.equal(vlcIosUrl(file.url), `vlc-x-callback://x-callback-url/stream?url=${enc}`);
  assert.equal(infuseUrl(file.url), `infuse://x-callback-url/play?url=${enc}`);
  assert.equal(outplayerUrl(file.url), `outplayer://${file.url}`);
  assert.equal(nplayerUrl(file.url), `nplayer-${file.url}`);
  assert.equal(nativeHref('infuse', 'ios', file), infuseUrl(file.url));
  assert.equal(nativeHref('vlc', 'ios', file), vlcIosUrl(file.url));
  assert.equal(nativeHref('copy', 'ios', file), null);
  assert.equal(nativeHref('vlc', 'desktop', file), null);
});

test('desktop playlist starts VLC at the room position', () => {
  assert.equal(m3uPlaylist(file), `#EXTM3U\n#EXTINF:-1,Matrix · VF\n#EXTVLCOPT:start-time=754\n${file.url}\n`);
  assert.ok(!m3uPlaylist({ ...file, position: 0 }).includes('start-time'));
  assert.ok(!m3uPlaylist({ ...file, title: 'a\nb' }).includes('a\nb'), 'one line title');
  assert.equal(playlistName('Dune: Part Two / S1E02'), 'Dune Part Two S1E02.m3u');
  assert.equal(playlistName(''), 'video.m3u');
});

test('options per platform, the site first inside Discord', () => {
  const ids = (p: Parameters<typeof externalOptions>[0], d: boolean) => externalOptions(p, d).map((o) => o.id);
  assert.deepEqual(ids('android', false), ['vlc', 'mx', 'mx-pro', 'chooser', 'copy']);
  assert.deepEqual(ids('ios', false), ['vlc', 'infuse', 'outplayer', 'nplayer', 'copy']);
  assert.deepEqual(ids('desktop', false), ['m3u', 'copy']);
  assert.deepEqual(ids('android', true), ['site', 'vlc', 'mx', 'mx-pro', 'chooser', 'copy']);
  assert.ok(externalOptions('ios', true).filter((o) => o.native).every((o) => o.id !== 'site' && o.id !== 'copy'));
});
