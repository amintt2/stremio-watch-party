import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCueText, decodeSubtitle, parseSubtitles, rankSubtitles } from '../src/subtitles.js';

test('SRT with CRLF, BOM and markup becomes clean cues', () => {
  const srt = '﻿1\r\n00:00:13,910 --> 00:00:16,504\r\n<b><i>Si je ne t\'aimais pas</i></b>\r\n\r\n2\r\n00:01:02,5 --> 00:01:04,000\r\n{\\an8}<font color="#ff0000">Deux</font>\r\nlignes\r\n\r\n';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 13.91, end: 16.504, text: "<b><i>Si je ne t'aimais pas</i></b>" },
    { start: 62.5, end: 64, text: 'Deux\nlignes' },
  ]);
});

test('WebVTT is read too, cue settings ignored', () => {
  const vtt = 'WEBVTT\n\nNOTE x\n\n00:05.000 --> 00:07.250 line:90%\nSalut\n\n01:00:00.000 --> 01:00:01.000\nFin\n';
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 5, end: 7.25, text: 'Salut' },
    { start: 3600, end: 3601, text: 'Fin' },
  ]);
});

test('broken cues are skipped, order fixed', () => {
  const srt = '1\n00:00:10,000 --> 00:00:09,000\nbackwards\n\n2\nnot a time --> x\nbad\n\n3\n00:00:05,000 --> 00:00:06,000\n\n\n4\n00:00:02,000 --> 00:00:03,000\nfirst\n';
  assert.deepEqual(parseSubtitles(srt), [{ start: 2, end: 3, text: 'first' }]);
});

test('cue text cannot inject markup', () => {
  assert.equal(cleanCueText('<script>alert(1)</script>Tom & Jerry <3'), 'alert(1)Tom &amp; Jerry &lt;3');
  assert.equal(cleanCueText('<I>ok</I> <img src=x onerror=y>'), '<i>ok</i>');
  assert.equal(cleanCueText('<i onclick="x">a</i>'), 'a</i>', 'attributes are not kept');
});

test('non-UTF-8 files are read as Windows-1252', () => {
  const latin = new Uint8Array([0x45, 0x6c, 0x6c, 0x65, 0x20, 0xe9, 0x74, 0xe9, 0x20, 0xe0, 0x20, 0xe7, 0x61]); // "Elle été à ça"
  assert.equal(decodeSubtitle(latin), 'Elle été à ça');
  assert.equal(decodeSubtitle(new TextEncoder().encode('déjà vu')), 'déjà vu');
});

test('subtitles: French first, a few per language, only http(s)', () => {
  const s = (lang, url = `https://x/${lang}`) => ({ lang, url });
  const list = [s('spa'), s('eng'), s('fre'), ...Array.from({ length: 9 }, () => s('eng')), s('fre', 'file:///etc/passwd'), { lang: 'ger' }];
  const ranked = rankSubtitles(list);
  assert.equal(ranked[0].lang, 'fre');
  assert.equal(ranked.filter((x) => x.lang === 'eng').length, 6);
  assert.equal(ranked.at(-1).lang, 'spa');
  assert.ok(ranked.every((x) => x.url.startsWith('https://')));
});
