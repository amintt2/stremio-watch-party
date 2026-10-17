// Pure helpers for the player controls (no DOM): volume mapping, seek bar maths,
// tap zones, keyboard shortcuts. Tested in controls.test.ts.
import { formatTime } from './sync.ts';

// ---------------------------------------------------------------- volume

/** Max volume in %, above 100 through a Web Audio gain. */
export const MAX_VOLUME = 130;
export const VOLUME_STEP = 5;

/** Whole percent in [0, max]; NaN → 100. */
export function clampVolume(pct: number, max = MAX_VOLUME) {
  if (!Number.isFinite(pct)) return 100;
  return Math.min(max, Math.max(0, Math.round(pct)));
}

/**
 * What to apply for a volume in %. Without the Web Audio route the element's own
 * volume does it all (capped at 100 %). Once routed through a GainNode, the element
 * stays at 1 and the gain does everything (so 0–130 % behave the same everywhere,
 * including iOS where video.volume is read-only).
 */
export function volumeOutput(pct: number, muted: boolean, routed: boolean) {
  const p = clampVolume(pct, routed ? MAX_VOLUME : 100);
  if (routed) return { element: 1, gain: muted ? 0 : p / 100 };
  return { element: p / 100, gain: 1 };
}

export function volumeIcon(pct: number, muted: boolean) {
  if (muted || pct <= 0) return 'mute';
  return pct < 50 ? 'volume-low' : 'volume';
}

/** "85 %" (French: narrow no-break space before %). */
export function formatPercent(pct: number) {
  return `${Math.round(pct)} %`;
}

/** Saved volume ("wp-volume"): {"v":85,"m":false}. Bad data → 100 %, not muted. */
export function parseVolume(raw: string | null): { pct: number; muted: boolean } {
  try {
    const v = JSON.parse(raw || '');
    return { pct: clampVolume(Number(v.v)), muted: v.m === true };
  } catch {
    return { pct: 100, muted: false };
  }
}

// ---------------------------------------------------------------- seek bar

/**
 * Position (0–1) under the pointer on a range input: the thumb's centre travels
 * from thumb/2 to width − thumb/2.
 */
export function seekRatio(x: number, left: number, width: number, thumb = 14) {
  const span = width - thumb;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (x - left - thumb / 2) / span));
}

/** End of the buffered range that contains t (small gaps tolerated), or t. */
export function bufferedEnd(ranges: [number, number][], t: number, tolerance = 0.5) {
  for (const [start, end] of ranges) if (t >= start - tolerance && t <= end + tolerance) return Math.max(t, end);
  return t;
}

/** Duration label: "2:30", or the time left "−1:23" when `remaining`. */
export function durationLabel(position: number, duration: number, remaining: boolean) {
  if (!remaining) return formatTime(duration);
  return `−${formatTime(Math.max(0, duration - position))}`;
}

/** Room seek target, kept inside the media. */
export function seekTarget(position: number, delta: number, duration: number) {
  const max = duration > 0 ? Math.max(0, duration - 1) : Infinity;
  return Math.min(max, Math.max(0, position + delta));
}

/** "+10 s" / "−20 s". */
export function formatDelta(delta: number) {
  return `${delta < 0 ? '−' : '+'}${Math.abs(Math.round(delta))} s`;
}

// ---------------------------------------------------------------- taps

export type TapZone = 'left' | 'center' | 'right';

/** Thirds of the surface: double-tap left = −10 s, right = +10 s. */
export function tapZone(x: number, width: number): TapZone {
  if (width <= 0) return 'center';
  const r = x / width;
  return r < 1 / 3 ? 'left' : r > 2 / 3 ? 'right' : 'center';
}

export interface Tap {
  t: number;
  x: number;
}

export const DOUBLE_TAP_MS = 300;

/** Second tap of a double tap: soon enough after the previous one, in the same side zone. */
export function isDoubleTap(prev: Tap | null, cur: Tap, width: number, windowMs = DOUBLE_TAP_MS) {
  if (!prev || cur.t - prev.t > windowMs || cur.t < prev.t) return false;
  const zone = tapZone(cur.x, width);
  return zone !== 'center' && zone === tapZone(prev.x, width);
}

// ---------------------------------------------------------------- keyboard

export type ShortcutAction =
  | 'toggle'
  | 'back'
  | 'forward'
  | 'volume-up'
  | 'volume-down'
  | 'mute'
  | 'fullscreen'
  | 'subtitles'
  | 'subs-earlier'
  | 'subs-later'
  | 'help'
  | 'escape';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Player shortcut for a key press. Letters go by `key`, not `code`, so they follow
 * the keyboard layout (M is not where KeyM is on AZERTY).
 */
export function shortcutAction(e: KeyLike): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === '?') return 'help';
  if (e.key === ' ' || e.code === 'Space') return 'toggle';
  switch (e.key) {
    case 'ArrowLeft':
      return 'back';
    case 'ArrowRight':
      return 'forward';
    case 'ArrowUp':
      return 'volume-up';
    case 'ArrowDown':
      return 'volume-down';
    case 'Escape':
      return 'escape';
  }
  switch (e.key.length === 1 ? e.key.toLowerCase() : '') {
    case 'k':
      return 'toggle';
    case 'j':
      return 'back';
    case 'l':
      return 'forward';
    case 'm':
      return 'mute';
    case 'f':
      return 'fullscreen';
    case 'c':
      return 'subtitles';
    case 'g':
      return 'subs-earlier';
    case 'h':
      return 'subs-later';
  }
  return null;
}

/** Shown in the "Raccourcis" help. */
export const SHORTCUTS: [string, string][] = [
  ['Espace / K', 'Lecture / pause (pour tout le monde)'],
  ['← / J', 'Reculer de 10 s'],
  ['→ / L', 'Avancer de 10 s'],
  ['↑ / ↓', 'Volume +5 % / −5 %'],
  ['M', 'Couper le son'],
  ['F', 'Plein écran'],
  ['C', 'Changer de sous-titres'],
  ['G / H', 'Sous-titres 0,1 s plus tôt / plus tard'],
  ['?', 'Afficher les raccourcis'],
  ['Échap', 'Fermer / réduire le lecteur'],
];

// ---------------------------------------------------------------- subtitles

/** Next entry of the subtitle menu (wraps to the first, usually "off"). */
export function nextOption(values: string[], current: string) {
  if (!values.length) return current;
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}
