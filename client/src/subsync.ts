// Automatic subtitle timing. Two signals tell where the lines really are:
//   - a reference subtitle known to be timed for this file (OpenSubtitles hash match),
//     even in another language: dialogue happens at the same moments;
//   - the film's own sound: voice-band energy measured while it plays (see speech.ts).
// Both are compared with the moments a subtitle shows text, for every candidate shift
// (and frame-rate ratio for the reference): the best correlation wins, if it clearly
// stands out from the others.

export interface Cue {
  start: number;
  end: number;
}

/** A subtitle line is shown at video time `start * ratio + offset`. */
export interface Timing {
  offset: number;
  ratio: number;
}

export interface SyncResult extends Timing {
  /** Correlation at the best shift (−1..1). */
  score: number;
  /** How far the best shift stands out from the others (z-score). */
  confidence: number;
}

/** Frame-rate conversions seen on subtitle sites: NTSC film ↔ PAL, 24 ↔ 23.976. */
export const RATIOS = [1, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24];

/** Subtitle line time → video time. */
export const toVideo = (t: number, timing: Timing) => t * timing.ratio + timing.offset;
/** Video time → subtitle line time. */
export const toCue = (t: number, timing: Timing) => (t - timing.offset) / timing.ratio;

/**
 * 1 where a line is shown, 0 elsewhere, one value per `step` seconds of subtitle time.
 * Lines longer than 15 s (signs, credits) are ignored: they are not speech.
 */
export function cueMask(cues: Cue[], step: number, length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const c of cues) {
    if (!(c.end > c.start) || c.end - c.start > 15) continue;
    const a = Math.max(0, Math.floor(c.start / step));
    const b = Math.min(length, Math.ceil(c.end / step));
    for (let i = a; i < b; i++) mask[i] = 1;
  }
  return mask;
}

const lastEnd = (cues: Cue[]) => cues.reduce((m, c) => Math.max(m, c.end), 0);

/** Pearson correlation of x (any values) and y (0/1) over the indexes where both exist. */
function correlate(xs: ArrayLike<number>, ys: Uint8Array, shift: number, scale: number, idx: Int32Array | null) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  const count = idx ? idx.length : xs.length;
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k;
    const j = Math.floor((i - shift) / scale);
    if (j < 0 || j >= ys.length) continue;
    const x = xs[i];
    const y = ys[j];
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y;
  }
  if (n < 20) return 0;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 1e-9 || vy <= 1e-9) return 0;
  return (sxy - (sx * sy) / n) / Math.sqrt(vx * vy);
}

interface Search {
  /** Video-time signal, one value per `step` seconds; NaN where unknown. */
  signal: Float32Array;
  step: number;
  cues: Cue[];
  ratios: number[];
  /** Offsets tried: center ± range (seconds). */
  center: number;
  range: number;
}

function search({ signal, step, cues, ratios, center, range }: Search): SyncResult | null {
  const known: number[] = [];
  for (let i = 0; i < signal.length; i++) if (!Number.isNaN(signal[i])) known.push(i);
  if (known.length < 50) return null;
  const idx = Int32Array.from(known);
  const mask = cueMask(cues, step, Math.ceil(lastEnd(cues) / step) + 1);
  const scores: number[] = [];
  let best: SyncResult | null = null;
  const shifts = Math.round(range / step);
  for (const ratio of ratios) {
    for (let s = -shifts; s <= shifts; s++) {
      const offset = center + s * step;
      const score = correlate(signal, mask, offset / step, ratio, idx);
      scores.push(score);
      if (!best || score > best.score) best = { offset, ratio, score, confidence: 0 };
    }
  }
  if (!best || best.score <= 0) return null;
  // Spread of the scores away from the peak (the peak's own neighbours look alike).
  const far = scores.filter((_, i) => {
    const r = Math.floor(i / (2 * shifts + 1));
    const s = (i % (2 * shifts + 1)) - shifts;
    return ratios[r] !== best!.ratio || Math.abs(center + s * step - best!.offset) > 1.5;
  });
  const mean = far.reduce((a, b) => a + b, 0) / Math.max(1, far.length);
  const sd = Math.sqrt(far.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, far.length)) || 1e-6;
  best.confidence = (best.score - mean) / sd;
  return best;
}

/** Refines a coarse result with a finer step around it. */
function refine(coarse: SyncResult, make: (step: number) => Float32Array, cues: Cue[], step: number, around: number): SyncResult {
  const fine = search({ signal: make(step), step, cues, ratios: [coarse.ratio], center: coarse.offset, range: around });
  return fine && fine.score >= coarse.score * 0.9 ? { ...fine, confidence: coarse.confidence } : coarse;
}

/**
 * Timing of `cues` that best matches `reference` (lines timed for this file).
 * Null when nothing clearly stands out.
 */
export function alignToReference(cues: Cue[], reference: Cue[], { maxOffset = 60, ratios = RATIOS } = {}): SyncResult | null {
  if (cues.length < 20 || reference.length < 20) return null;
  const length = lastEnd(reference) + maxOffset;
  const make = (step: number) => {
    const m = cueMask(reference, step, Math.ceil(length / step));
    return Float32Array.from(m);
  };
  const coarse = search({ signal: make(0.5), step: 0.5, cues, ratios, center: 0, range: maxOffset });
  if (!coarse || coarse.confidence < 6 || coarse.score < 0.2) return null;
  return round(refine(coarse, make, cues, 0.05, 0.75));
}

/**
 * Speech energy measured while playing: video time (s) → value (higher = more voice).
 * Only the moments actually heard are compared.
 */
export function alignToSpeech(
  cues: Cue[],
  samples: Map<number, number>,
  sampleStep: number,
  current: Timing,
  { maxShift = 20 } = {}
): SyncResult | null {
  if (cues.length < 8 || samples.size < 300) return null;
  let maxIndex = 0;
  for (const i of samples.keys()) maxIndex = Math.max(maxIndex, i);
  const signal = new Float32Array(maxIndex + 1).fill(NaN);
  for (const [i, v] of samples) signal[i] = v;
  // Search in subtitle time around the current timing: shift the lines, keep the ratio.
  const scaled = cues.map((c) => ({ start: c.start * current.ratio, end: c.end * current.ratio }));
  const result = search({ signal, step: sampleStep, cues: scaled, ratios: [1], center: current.offset, range: maxShift });
  if (!result || result.confidence < 4.5 || result.score < 0.12) return null;
  return round({ ...result, ratio: current.ratio });
}

const round = (r: SyncResult): SyncResult => ({ ...r, offset: Math.round(r.offset * 100) / 100 });

/**
 * Frame-rate hint from the subtitle site: a file timed for 25 fps on a 23.976 fps
 * video runs 4 % fast. Only the PAL conversions: "24" often just means 23.976 there.
 */
export function fpsRatio(subtitleFps: number | null | undefined, videoFps: number | null | undefined): number {
  if (!subtitleFps || !videoFps) return 1;
  const r = subtitleFps / videoFps;
  return RATIOS.find((x) => Math.abs(x - 1) > 0.01 && Math.abs(x - r) < 0.003) ?? 1;
}
