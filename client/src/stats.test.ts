import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsView, type StatsInput } from './stats.ts';

const base: StatsInput = {
  source: { kind: 'torrent', engine: 'huwa', peers: 12, downloadSpeed: 3_100_000, progress: 0.256, level: 'ok', gpu: null },
  media: { codec: 'hevc', width: 3840, height: 2160, hdr: true },
  quality: '1080',
  output: { mode: 'transcode', codec: 'h264' },
  caps: { hevc: false, av1: true, vp9: true },
  names: { alice: 'Alice' },
  me: 'bob',
  buffer: 14.2,
  ratio: 2.34,
  frames: 1234,
  dropped: 3,
  loadingFor: null,
  error: null,
  fallback: null,
};
const row = (v: ReturnType<typeof statsView>, label: string) => v.rows.find((r) => r.label === label)?.value;

test('like Stremio: peers, speed, done', () => {
  const v = statsView(base);
  assert.deepEqual(v.top, [
    { label: 'Pairs', value: '12' },
    { label: 'Vitesse', value: '3,1 Mo/s' },
    { label: 'Terminé', value: '25,6 %' },
  ]);
  assert.equal(row(v, 'Source'), 'Torrent, moteur Huwa');
  assert.equal(row(v, 'Vidéo'), 'HEVC · 3840×2160 · HDR');
  assert.equal(row(v, 'Pour toi'), '1080p, convertie en H.264 par le serveur');
  assert.equal(row(v, 'Accélération GPU'), 'Aucune : personne dans la salle n’a lancé l’encodeur');
  assert.equal(row(v, 'Cet appareil lit'), 'H.264, AV1, VP9');
});

test('the GPU line tells whether it really works, and why not', () => {
  const gpu = { by: 'alice', encoder: 'NVENC', device: 'RTX 4070' };
  let v = statsView({ ...base, source: { ...base.source!, gpu: { ...gpu, status: 'working', fps: 140 } } });
  assert.equal(row(v, 'Accélération GPU'), 'Active : NVENC · RTX 4070 (le PC de Alice), 140 images/s');
  assert.equal(row(v, 'Pour toi'), '1080p, convertie en H.264 par le PC de Alice');

  v = statsView({ ...base, me: 'alice', output: { mode: 'copy', codec: 'hevc' }, source: { ...base.source!, gpu: { ...gpu, status: 'ready' } } });
  assert.equal(row(v, 'Accélération GPU'), 'Prête : NVENC · RTX 4070 (ton PC) · rien à convertir pour toi (vidéo lue telle quelle)');
  assert.equal(row(v, 'Pour toi'), '1080p, telle quelle (HEVC, aucune conversion)');

  v = statsView({ ...base, source: { ...base.source!, gpu: { ...gpu, status: 'retry', error: 'ffmpeg a quitté', retryIn: 45 } } });
  assert.match(row(v, 'Accélération GPU')!, /En pause .*ffmpeg a quitté.*45 s/);
});

test('loading, errors and the H.264 fallback show up first', () => {
  assert.equal(statsView({ ...base, loadingFor: 25 }).rows[0].tone, 'warn');
  assert.match(statsView({ ...base, loadingFor: 25 }).rows[0].value, /Chargement depuis 25 s/);
  const v = statsView({ ...base, fallback: 'HEVC non affiché ici : passage en H.264' });
  assert.equal(row(v, 'Compatibilité'), 'HEVC non affiché ici : passage en H.264');
  assert.deepEqual(statsView({ ...base, source: { kind: 'http', gpu: null } }).top, []);
});
