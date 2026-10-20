// Pure helpers for this viewer's playback health (no DOM), tested in health.test.ts:
// how far ahead the video is buffered, how fast segments arrive compared with the
// stream bitrate, and where to land when catching up with the room.

export type Health = 'good' | 'fair' | 'poor';

export interface HealthInput {
  /** Seconds buffered ahead of currentTime. */
  ahead: number;
  /** EWMA of download speed / media bitrate (1 = exactly real time); null = no sample yet. */
  ratio: number | null;
  /** Seconds left in the media (a small buffer at the very end is fine). */
  left: number;
}

/**
 * green: comfortable buffer and segments arrive well faster than real time.
 * orange: thin buffer or barely faster than real time.
 * red: the buffer is almost empty, or segments arrive slower than they play.
 */
export function bufferHealth({ ahead, ratio, left }: HealthInput): Health {
  const need = Math.min(left, 30);
  const enough = (s: number) => ahead >= Math.min(s, need - 0.5);
  if (!enough(3) || (ratio !== null && ratio < 1 && !enough(20))) return 'poor';
  if (!enough(10) || (ratio !== null && ratio < 1.3 && !enough(30))) return 'fair';
  return 'good';
}

export const HEALTH_LABEL: Record<Health, string> = {
  good: 'Connexion stable',
  fair: 'Connexion juste',
  poor: 'Risque de coupure',
};

/** Download speed / media bitrate for one segment, or null when it says nothing. */
export function fragmentRatio(bytes: number, loadMs: number, durationS: number): number | null {
  if (bytes < 10_000 || loadMs <= 0 || durationS <= 0) return null;
  const throughput = (bytes * 8) / (loadMs / 1000);
  const bitrate = (bytes * 8) / durationS;
  return throughput / bitrate;
}

export function ewma(prev: number | null, sample: number, alpha = 0.3) {
  return prev === null ? sample : prev * (1 - alpha) + sample * alpha;
}

/** Seconds buffered after t (0 when t is not in a buffered range). */
export function bufferedAhead(ranges: [number, number][], t: number, tolerance = 0.3) {
  for (const [start, end] of ranges) if (t >= start - tolerance && t < end) return end - t;
  return 0;
}

/** Next quality below `current` in a best → worst ladder, or null. */
export function lowerQuality(ladder: string[], current: string | null) {
  const i = current ? ladder.indexOf(current) : -1;
  return i >= 0 && i < ladder.length - 1 ? ladder[i + 1] : null;
}

/** What the server reports about a torrent source (GET /api/media/:sid/health). */
export interface SourceHealth {
  kind: 'torrent' | 'http';
  level?: 'ok' | 'slow' | 'searching' | 'stalled' | 'done' | 'unknown';
  peers?: number;
  downloadSpeed?: number;
  /** Share of the file downloaded on the server (0–1). */
  progress?: number | null;
  /** Torrent engine: "huwa" or "stremio". */
  engine?: string;
  /** The room's GPU encoder, if a member runs the app (server/src/encoder.js state()). */
  gpu?: GpuState | null;
}

export interface GpuState {
  /** working: segments going out now · ready: holds the film, nothing asked yet ·
   *  idle: online, film not handed to it · retry: taken back after an error. */
  status: 'working' | 'ready' | 'idle' | 'retry';
  by: string;
  encoder: string | null;
  device: string | null;
  fps?: number | null;
  error?: string | null;
  retryIn?: number;
}

/** 3 100 000 → "3,1 Mo/s", 52 000 → "52 Ko/s". */
export function speedLabel(bytesPerS: number) {
  if (bytesPerS < 1e6) return `${Math.round(bytesPerS / 1e3)} Ko/s`;
  return `${(bytesPerS / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo/s`;
}

/** "Torrent : 12 pairs · 3,1 Mo/s" for the health details. */
export function sourceDetail(s: SourceHealth | null) {
  if (!s || s.kind !== 'torrent' || !s.level || s.level === 'unknown') return '';
  if (s.level === 'done') return 'Torrent : fichier complet sur le serveur';
  const peers = s.peers ?? 0;
  return `Torrent : ${peers} pair${peers > 1 ? 's' : ''} · ${speedLabel(s.downloadSpeed ?? 0)}`;
}

/**
 * When the server itself can't get the file fast enough, lowering this viewer's quality
 * won't help: say so (it hits everyone) instead of blaming the viewer's connection.
 * Only once this viewer is actually suffering: thin buffer, or stuck (loading, catching
 * up, the room waiting), when the buffer meter itself has nothing to show.
 */
export function sourceProblem(s: SourceHealth | null, health: Health | null, stuck = false) {
  if (!s || s.kind !== 'torrent') return null;
  if (!stuck && (health === 'good' || health === null)) return null;
  if (s.level === 'stalled') return 'La source torrent ne trouve plus de pairs : essaie une autre source.';
  if (s.level === 'searching') return 'La source torrent cherche des pairs…';
  if (s.level === 'slow') return 'La source torrent est plus lente que la vidéo, pour tout le monde : essaie une autre source.';
  return null;
}
