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

export const MAX_LEAD_S = 4;

/**
 * Where to jump when this viewer fell behind the room. Inside the buffer: exactly
 * the room position (the jump is instant). Outside: a bit ahead of it, by about how
 * long the last unbuffered jumps took to load, then wait there for the room. Jumping
 * to the room position itself always lands behind again once the segment is loaded,
 * which used to start another jump, and another: picture and sound cut while the
 * room clock kept going.
 */
export function catchUpTarget(expected: number, ranges: [number, number][], latencyS: number) {
  if (bufferedAhead(ranges, expected, 0) >= 0.5) return { position: expected, lead: 0 };
  const lead = Math.min(MAX_LEAD_S, Math.max(1, latencyS));
  return { position: expected + lead, lead };
}
