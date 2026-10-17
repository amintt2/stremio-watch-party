// How subtitles look, per viewer (this device): font, size, colours, outline, shadow,
// background and height. Sizes are shares of the picture's height, like on a TV, so
// they look the same in the mini-player, a window or full screen.
import { localStorageGet, localStorageSet } from './storage.ts';

export type SubFont = 'nunito' | 'system' | 'atkinson' | 'serif' | 'comic' | 'mono';
export type SubBackground = 'none' | 'box' | 'band';

export interface SubStyle {
  font: SubFont;
  /** Index in SIZE_LEVELS. */
  size: number;
  color: string;
  /** Index in OUTLINE_LEVELS. */
  outline: number;
  outlineColor: string;
  /** Index in SHADOW_LEVELS. */
  shadow: number;
  background: SubBackground;
  /** Background opacity, 0..1. */
  bgOpacity: number;
  /** Index in POSITION_LEVELS. */
  position: number;
  bold: boolean;
}

export const FONTS: { id: SubFont; label: string; hint: string; family: string; weights: [number, number] }[] = [
  { id: 'nunito', label: 'Nunito', hint: 'Arrondie, la plus lisible', family: "'Nunito', system-ui, sans-serif", weights: [600, 800] },
  { id: 'system', label: 'Système', hint: 'La police de ton appareil', family: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', weights: [500, 700] },
  { id: 'atkinson', label: 'Atkinson', hint: 'Conçue pour les malvoyants', family: "'Atkinson Hyperlegible', system-ui, sans-serif", weights: [400, 700] },
  { id: 'serif', label: 'Serif', hint: 'Comme au cinéma', family: 'Georgia, "Times New Roman", serif', weights: [400, 700] },
  { id: 'comic', label: 'Comic Neue', hint: 'Bulle de BD', family: "'Comic Neue', 'Comic Sans MS', sans-serif", weights: [400, 700] },
  { id: 'mono', label: 'Mono', hint: 'Chasse fixe', family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', weights: [500, 700] },
];

/** Font size, share of the picture height (with a floor for tiny players). */
export const SIZE_LEVELS = [
  { label: 'Très petite', short: 'XS', pct: 0.038 },
  { label: 'Petite', short: 'S', pct: 0.045 },
  { label: 'Moyenne', short: 'M', pct: 0.052 },
  { label: 'Grande', short: 'L', pct: 0.06 },
  { label: 'Très grande', short: 'XL', pct: 0.07 },
  { label: 'Énorme', short: 'XXL', pct: 0.082 },
];

/** Outline width, share of the font size. */
export const OUTLINE_LEVELS = [
  { label: 'Aucun', k: 0 },
  { label: 'Fin', k: 0.045 },
  { label: 'Normal', k: 0.075 },
  { label: 'Épais', k: 0.105 },
  { label: 'Très épais', k: 0.14 },
];

/** Drop shadow distance, share of the font size. */
export const SHADOW_LEVELS = [
  { label: 'Aucune', k: 0 },
  { label: 'Légère', k: 0.04 },
  { label: 'Moyenne', k: 0.07 },
  { label: 'Forte', k: 0.1 },
];

/** Bottom line height above the picture's bottom edge, share of its height. */
export const POSITION_LEVELS = [
  { label: 'Tout en bas', pct: 0.03 },
  { label: 'Bas', pct: 0.06 },
  { label: 'Un peu plus haut', pct: 0.1 },
  { label: 'Haut', pct: 0.15 },
  { label: 'Très haut', pct: 0.22 },
];

export const TEXT_COLORS = [
  { label: 'Blanc', value: '#FFFFFF' },
  { label: 'Blanc cassé', value: '#F1EEE4' },
  { label: 'Jaune', value: '#FFE14D' },
  { label: 'Cyan', value: '#8FE3FF' },
  { label: 'Vert', value: '#B8F5A1' },
  { label: 'Rose', value: '#FFB8D6' },
];

export const OUTLINE_COLORS = [
  { label: 'Noir', value: '#000000' },
  { label: 'Anthracite', value: '#1C1F26' },
  { label: 'Bleu nuit', value: '#0B1640' },
  { label: 'Bordeaux', value: '#3A0A14' },
  { label: 'Blanc', value: '#FFFFFF' },
];

export const BACKGROUNDS: { id: SubBackground; label: string }[] = [
  { id: 'none', label: 'Aucun' },
  { id: 'box', label: 'Boîte' },
  { id: 'band', label: 'Bande' },
];

export const BG_OPACITIES = [0.35, 0.55, 0.75, 0.9];

export const DEFAULT_STYLE: SubStyle = {
  font: 'nunito',
  size: 2,
  color: '#FFFFFF',
  outline: 2,
  outlineColor: '#000000',
  shadow: 1,
  background: 'none',
  bgOpacity: 0.55,
  position: 1,
  bold: true,
};

const STYLE_KEY = 'wp-subs-style';
/** Older single setting (S/M/L/XL), read once. */
const OLD_SIZE_KEY = 'wp-subs-size';
const HEX = /^#[0-9A-F]{6}$/i;

export function sanitizeStyle(raw: unknown): SubStyle {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<SubStyle>;
  const d = DEFAULT_STYLE;
  const int = (x: unknown, max: number, fb: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max ? x : fb);
  return {
    font: FONTS.some((f) => f.id === v.font) ? (v.font as SubFont) : d.font,
    size: int(v.size, SIZE_LEVELS.length - 1, d.size),
    color: typeof v.color === 'string' && HEX.test(v.color) ? v.color : d.color,
    outline: int(v.outline, OUTLINE_LEVELS.length - 1, d.outline),
    outlineColor: typeof v.outlineColor === 'string' && HEX.test(v.outlineColor) ? v.outlineColor : d.outlineColor,
    shadow: int(v.shadow, SHADOW_LEVELS.length - 1, d.shadow),
    background: BACKGROUNDS.some((b) => b.id === v.background) ? (v.background as SubBackground) : d.background,
    bgOpacity: typeof v.bgOpacity === 'number' && v.bgOpacity >= 0 && v.bgOpacity <= 1 ? v.bgOpacity : d.bgOpacity,
    position: int(v.position, POSITION_LEVELS.length - 1, d.position),
    bold: typeof v.bold === 'boolean' ? v.bold : d.bold,
  };
}

let current: SubStyle | null = null;
const listeners = new Set<(s: SubStyle) => void>();

export function subtitleStyle(): SubStyle {
  if (current) return current;
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorageGet(STYLE_KEY) || 'null');
  } catch {}
  if (!raw) {
    const old = { s: 1, m: 2, l: 3, xl: 4 }[localStorageGet(OLD_SIZE_KEY) || ''];
    raw = old === undefined ? null : { size: old };
  }
  current = sanitizeStyle(raw);
  return current;
}

export function setSubtitleStyle(patch: Partial<SubStyle>) {
  current = sanitizeStyle({ ...subtitleStyle(), ...patch });
  localStorageSet(STYLE_KEY, JSON.stringify(current));
  for (const l of listeners) l(current);
}

export function resetSubtitleStyle() {
  setSubtitleStyle(DEFAULT_STYLE);
}

/** Calls `fn` on every change (from the player menu or the settings page). */
export function onSubtitleStyle(fn: (s: SubStyle) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const rgba = (hex: string, a: number) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
};

/**
 * Outline drawn as a ring of shadows (every browser, any font), then the drop shadow.
 * Sizes in px.
 */
export function textShadow(outline: number, color: string, shadow: number) {
  const parts: string[] = [];
  if (outline > 0) {
    const steps = outline > 2.5 ? 16 : 8;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      parts.push(`${(Math.cos(a) * outline).toFixed(2)}px ${(Math.sin(a) * outline).toFixed(2)}px 0 ${color}`);
    }
    parts.push(`0 0 ${(outline * 0.6).toFixed(2)}px ${color}`);
  }
  if (shadow > 0) parts.push(`${shadow.toFixed(2)}px ${shadow.toFixed(2)}px ${(shadow * 1.2).toFixed(2)}px rgba(0, 0, 0, 0.85)`);
  return parts.length ? parts.join(', ') : 'none';
}

/** Height of the picture inside a box (letterboxed when the shapes differ). */
export function pictureHeight(boxWidth: number, boxHeight: number, videoWidth: number, videoHeight: number) {
  if (!videoWidth || !videoHeight || !boxWidth) return boxHeight;
  return Math.min(boxHeight, (boxWidth * videoHeight) / videoWidth);
}

/** CSS custom properties for a style, for a picture `height` px tall inside a box `box` px tall. */
export function styleVars(s: SubStyle, height: number, box = height): Record<string, string> {
  const font = FONTS.find((f) => f.id === s.font) || FONTS[0];
  const size = Math.max(12, height * SIZE_LEVELS[s.size].pct);
  const outline = size * OUTLINE_LEVELS[s.outline].k;
  const shadow = size * SHADOW_LEVELS[s.shadow].k;
  const letterbox = Math.max(0, (box - height) / 2);
  return {
    '--subs-size': `${size.toFixed(1)}px`,
    '--subs-family': font.family,
    '--subs-weight': String(font.weights[s.bold ? 1 : 0]),
    '--subs-color': s.color,
    '--subs-shadow': textShadow(outline, s.outlineColor, shadow),
    '--subs-box': s.background === 'box' ? rgba('#000000', s.bgOpacity) : 'transparent',
    '--subs-band': s.background === 'band' ? rgba('#000000', s.bgOpacity) : 'transparent',
    '--subs-bottom': `${(letterbox + height * POSITION_LEVELS[s.position].pct).toFixed(1)}px`,
  };
}

export function applyStyleVars(el: HTMLElement, vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}
