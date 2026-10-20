// The player's statistics panel, like Stremio's (peers, speed, done) plus what Watch Party
// adds: what this viewer receives (the source as is or converted), who converts it (a
// member's GPU or the server), and why the picture would not come. Pure: tested in
// stats.test.ts; stage.ts draws it.
import type { Caps } from './codecprobe.ts';
import { speedLabel, type GpuState, type SourceHealth } from './health.ts';

export interface StatsInput {
  source: SourceHealth | null;
  media: { codec: string; width: number; height: number; hdr?: boolean; dolbyVision?: boolean } | null;
  quality: string | null;
  output: { mode: 'copy' | 'transcode'; codec: string } | null;
  caps: Caps;
  /** Member names by uid (who runs the GPU). */
  names: Record<string, string>;
  me: string | null;
  buffer: number;
  ratio: number | null;
  frames: number | null;
  dropped: number | null;
  /** Seconds since this quality started loading, while nothing plays yet; null once playing. */
  loadingFor: number | null;
  error: string | null;
  fallback: string | null;
}

export interface StatsView {
  /** The three big numbers (torrent only). */
  top: { label: string; value: string }[];
  rows: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }[];
}

const CODEC: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', vc1: 'VC-1' };
const codecName = (c: string) => CODEC[c] || c.toUpperCase();
const nf = (n: number) => n.toLocaleString('fr-FR');

function who(gpu: GpuState, input: StatsInput) {
  if (gpu.by === input.me) return 'ton PC';
  return `le PC de ${input.names[gpu.by] || 'un membre'}`;
}

function gpuLabel(gpu: GpuState) {
  return [gpu.encoder, gpu.device].filter(Boolean).join(' · ') || 'GPU';
}

/** The GPU line: is it really working, and if not, why. */
export function gpuRow(gpu: GpuState | null | undefined, input: StatsInput): StatsView['rows'][number] {
  if (!gpu) return { label: 'Accélération GPU', value: 'Aucune : personne dans la salle n’a lancé l’encodeur' };
  const where = `${gpuLabel(gpu)} (${who(gpu, input)})`;
  const copyHere = input.output?.mode === 'copy';
  switch (gpu.status) {
    case 'working':
      return {
        label: 'Accélération GPU',
        value: `Active : ${where}${gpu.fps ? `, ${gpu.fps} images/s` : ''}${copyHere ? ' · pas pour toi : tu reçois la vidéo telle quelle' : ''}`,
        tone: 'good',
      };
    case 'ready':
      return {
        label: 'Accélération GPU',
        value: copyHere
          ? `Prête : ${where} · rien à convertir pour toi (vidéo lue telle quelle)`
          : `Prête : ${where}, démarre au prochain segment`,
        tone: 'good',
      };
    case 'retry':
      return {
        label: 'Accélération GPU',
        value: `En pause : ${where} a eu un problème (${gpu.error || 'erreur'}). Le serveur convertit ; nouvel essai dans ${gpu.retryIn ?? 0} s`,
        tone: 'warn',
      };
    default:
      return { label: 'Accélération GPU', value: `Connectée : ${where}, pas encore sur ce film`, tone: 'warn' };
  }
}

export function statsView(input: StatsInput): StatsView {
  const src = input.source;
  const top: StatsView['top'] = [];
  if (src?.kind === 'torrent') {
    top.push({ label: 'Pairs', value: src.peers !== undefined ? nf(src.peers) : '…' });
    top.push({ label: 'Vitesse', value: src.downloadSpeed !== undefined ? speedLabel(src.downloadSpeed) : '…' });
    top.push({
      label: 'Terminé',
      value: typeof src.progress === 'number' ? `${(src.progress * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : '…',
    });
  }
  const rows: StatsView['rows'] = [];

  if (input.error) rows.push({ label: 'État', value: input.error, tone: 'bad' });
  else if (input.loadingFor !== null)
    rows.push({
      label: 'État',
      value: `Chargement depuis ${Math.round(input.loadingFor)} s${input.output?.mode === 'transcode' ? ' (le serveur ou le GPU prépare la vidéo)' : ''}`,
      tone: input.loadingFor > 20 ? 'warn' : undefined,
    });
  else rows.push({ label: 'État', value: 'Lecture', tone: 'good' });
  if (input.fallback) rows.push({ label: 'Compatibilité', value: input.fallback, tone: 'warn' });

  if (src) {
    const engine = src.kind === 'http' ? 'Lien direct (débrid)' : src.engine === 'huwa' ? 'Torrent, moteur Huwa' : 'Torrent, moteur Stremio';
    rows.push({ label: 'Source', value: engine });
  }
  if (input.media) {
    const m = input.media;
    const extra = m.dolbyVision ? ' · Dolby Vision' : m.hdr ? ' · HDR' : '';
    rows.push({ label: 'Vidéo', value: `${codecName(m.codec)} · ${m.width}×${m.height}${extra}` });
  }
  if (input.output && input.quality) {
    const q = input.quality === '2160' ? '4K' : `${input.quality}p`;
    let how: string;
    if (input.output.mode === 'copy') how = `telle quelle (${codecName(input.output.codec)}, aucune conversion)`;
    else if (src?.gpu && (src.gpu.status === 'working' || src.gpu.status === 'ready')) how = `convertie en H.264 par ${who(src.gpu, input)}`;
    else how = 'convertie en H.264 par le serveur';
    rows.push({ label: 'Pour toi', value: `${q}, ${how}` });
  }
  rows.push(gpuRow(src?.gpu, input));

  const ratio = input.ratio !== null ? ` · arrive ${input.ratio.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}× plus vite que la lecture` : '';
  rows.push({ label: 'Tampon', value: `${Math.round(input.buffer)} s${ratio}`, tone: input.buffer < 3 && input.loadingFor === null ? 'warn' : undefined });
  if (input.frames !== null) {
    rows.push({ label: 'Images', value: `${nf(input.frames)} affichées${input.dropped ? ` · ${nf(input.dropped)} perdues` : ''}` });
  }
  const codecs = ['H.264', ...(['hevc', 'av1', 'vp9'] as const).filter((c) => input.caps[c]).map(codecName)];
  rows.push({ label: 'Cet appareil lit', value: codecs.join(', ') });
  return { top, rows };
}
