import { api } from './api.ts';
import { localStorageGet, localStorageSet } from './storage.ts';
import { h } from './dom.ts';
import { activeCues, langCode, languageName, type TimedCue } from './format.ts';
import { SPEECH_STEP } from './speech.ts';
import { alignToReference, alignToSpeech, fpsRatio, toCue, toVideo, type Timing } from './subsync.ts';

export interface SubtitleOption {
  key: string;
  /** Stable id of the file (timing is remembered per video and file). */
  ref: string;
  lang: string;
  source: string;
  /** 'hash': made for this exact file; 'release': for the same release name. */
  match: 'hash' | 'release' | null;
  release: string | null;
  /** Frame rate the file was timed for, when the site says. */
  fps: number | null;
}

/** How the current timing was found. */
export type SyncMethod = 'file' | 'reference' | 'audio' | 'fps' | 'manual' | 'saved' | 'none';

/** This viewer's subtitle language ("fr", "en"…), or "" for none. */
const LANG_KEY = 'wp-subs';
/** "0": automatic sync off. */
const AUTO_KEY = 'wp-subs-autosync';
/** Remembered timings: "videoId|ref" → { o, r, m }. */
const TIMING_KEY = 'wp-subs-timing';
const MAX_REMEMBERED = 200;

const ZERO: Timing = { offset: 0, ratio: 1 };

function remembered(): Record<string, { o: number; r: number; m: SyncMethod; t: number }> {
  try {
    const v = JSON.parse(localStorageGet(TIMING_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Subtitles from subtitle addons (OpenSubtitles), chosen by each viewer for
 * themselves and drawn over the video, with their own timing:
 *   - files made for this exact video (hash) are used as they are;
 *   - others are aligned on such a file when there is one (any language), else on the
 *     film's voices as it plays; the viewer can always adjust by hand.
 */
export class ExternalSubtitles {
  options: SubtitleOption[] = [];
  /** Key of the selected subtitle, or null. */
  selected: string | null = null;
  timing: Timing = { ...ZERO };
  method: SyncMethod = 'none';
  /** Auto-sync is looking for the timing (shown in the menu). */
  syncing = false;
  loading = false;
  error: string | null = null;
  onChange: () => void = () => {};
  /** A timing was found automatically: the stage tells the viewer. */
  onAutoSync: (message: string) => void = () => {};

  private sid: string | null = null;
  private videoId = '';
  private videoFps: number | null = null;
  private cues: TimedCue[] = [];
  private fileCues: TimedCue[] | null = null;
  private shown = '';
  private seq = 0;
  /** Last audio result not applied yet (two in a row must agree). */
  private pending: Timing | null = null;

  private readonly overlay: HTMLElement;

  constructor(overlay: HTMLElement) {
    this.overlay = overlay;
  }

  get lang() {
    return localStorageGet(LANG_KEY) || '';
  }

  /** The viewer chose subtitles of this language elsewhere (a track of the file): next films too. */
  remember(lang: string) {
    localStorageSet(LANG_KEY, langCode(lang));
  }

  /** True when the file itself has subtitles in the viewer's language (better timed): no OpenSubtitles pick then. */
  preferFile: () => boolean = () => false;

  get auto() {
    return localStorageGet(AUTO_KEY) !== '0';
  }

  set auto(on: boolean) {
    localStorageSet(AUTO_KEY, on ? '1' : '0');
    if (on && this.method !== 'file') void this.autoAlign();
    this.onChange();
  }

  get current(): SubtitleOption | null {
    return this.options.find((s) => s.key === this.selected) || null;
  }

  /** New media: fetch its subtitle list and apply the viewer's language. */
  async load(sid: string | null, video: { videoId?: string; fps?: number | null } = {}) {
    if (sid === this.sid) return;
    this.sid = sid;
    this.videoId = video.videoId || sid || '';
    this.videoFps = video.fps ?? null;
    this.options = [];
    this.error = null;
    this.clearSelection();
    if (!sid) return this.onChange();
    const seq = ++this.seq;
    try {
      const { items } = await api<{ items: SubtitleOption[] }>(`/api/subtitles/${encodeURIComponent(sid)}`);
      if (seq !== this.seq) return;
      this.options = items;
      const wanted = this.lang;
      // Best one of the viewer's language: the server puts files made for this video first.
      const match = wanted ? items.find((s) => langCode(s.lang) === wanted) : null;
      if (match && !this.preferFile()) await this.select(match.key, false);
    } catch (err) {
      if (seq === this.seq) this.error = (err as Error).message;
    }
    if (seq === this.seq) this.onChange();
  }

  /** remember=false when applied automatically (keeps the saved language as is). */
  async select(key: string | null, remember = true) {
    const option = this.options.find((s) => s.key === key) || null;
    if (remember) localStorageSet(LANG_KEY, option ? langCode(option.lang) : '');
    this.clearSelection();
    if (!option) return this.onChange();
    this.selected = option.key;
    this.loading = true;
    this.onChange();
    const seq = this.seq;
    try {
      const { cues } = await api<{ cues: TimedCue[] }>(`/api/subtitles/cues/${encodeURIComponent(option.key)}`);
      if (seq !== this.seq || this.selected !== option.key) return;
      this.cues = cues;
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      this.selected = null;
    }
    this.loading = false;
    if (this.selected) this.initialTiming(option);
    this.onChange();
  }

  private initialTiming(option: SubtitleOption) {
    const saved = remembered()[this.memoryKey(option)];
    if (saved) {
      this.timing = { offset: saved.o, ratio: saved.r };
      // Found before for this file: say how (the audio may still refine its own result).
      this.method = (['manual', 'reference', 'audio', 'fps'] as SyncMethod[]).includes(saved.m) ? saved.m : 'saved';
      return;
    }
    if (option.match === 'hash') {
      this.method = 'file';
      return;
    }
    const ratio = fpsRatio(option.fps, this.videoFps);
    if (ratio !== 1) {
      this.timing = { offset: 0, ratio };
      this.method = 'fps';
    }
    if (this.auto) void this.autoAlign();
  }

  /**
   * Aligns on a file made for this video (another language works: people speak at the
   * same moments). Without one, the film's sound does it as it plays (`listen`).
   */
  private async autoAlign() {
    const option = this.current;
    if (!option || option.match === 'hash' || this.method === 'manual') return;
    const reference = this.options.find((o) => o.match === 'hash' && o.key !== option.key);
    if (!reference) return;
    const seq = this.seq;
    const key = option.key;
    this.syncing = true;
    this.onChange();
    try {
      if (!this.fileCues) this.fileCues = (await api<{ cues: TimedCue[] }>(`/api/subtitles/cues/${encodeURIComponent(reference.key)}`)).cues;
      // The viewer may have nudged it meanwhile.
      if (seq !== this.seq || this.selected !== key || (this.method as SyncMethod) === 'manual') return;
      const result = alignToReference(this.cues, this.fileCues);
      if (result) {
        this.apply(result, 'reference');
        this.onAutoSync(`Sous-titres calés sur une version faite pour ce fichier (${formatOffset(result.offset)})`);
      }
    } catch {
      /* the audio still can */
    } finally {
      if (seq === this.seq) {
        this.syncing = false;
        this.onChange();
      }
    }
  }

  /**
   * Called every few seconds with the voice levels heard so far: corrects the timing
   * from the sound when nothing better was found.
   */
  listen(samples: Map<number, number>) {
    const option = this.current;
    if (!option || !this.auto || this.loading || !this.cues.length) return;
    if (option.match === 'hash' || ['manual', 'reference'].includes(this.method)) return;
    const result = alignToSpeech(this.cues, samples, SPEECH_STEP, this.timing);
    if (!result) return;
    const moved = Math.abs(result.offset - this.timing.offset);
    if (moved < 0.15) {
      this.pending = null;
      if (this.method !== 'audio') {
        this.method = 'audio';
        this.onChange();
      }
      return;
    }
    // A first clear answer is applied at once; later changes must be seen twice.
    const first = this.method !== 'audio';
    const confirmed = this.pending && Math.abs(this.pending.offset - result.offset) < 0.3;
    if ((first && result.confidence >= 6) || confirmed) {
      this.pending = null;
      this.apply(result, 'audio');
      this.onAutoSync(`Sous-titres synchronisés sur l'audio (${formatOffset(result.offset)})`);
    } else this.pending = { offset: result.offset, ratio: result.ratio };
  }

  /** Manual nudge: the viewer's timing wins over automatic sync for this file. */
  shift(delta: number) {
    this.apply({ offset: Math.round((this.timing.offset + delta) * 100) / 100, ratio: this.timing.ratio }, 'manual');
  }

  /** "I just heard this line": its start is now (minus a reaction time). */
  heardNow(cue: TimedCue, now: number) {
    const offset = Math.round((now - 0.35 - cue.start * this.timing.ratio) * 100) / 100;
    this.apply({ offset, ratio: this.timing.ratio }, 'manual');
  }

  /** Back to the file's own timing, then automatic sync again. */
  resetTiming() {
    const option = this.current;
    if (!option) return;
    const all = remembered();
    delete all[this.memoryKey(option)];
    localStorageSet(TIMING_KEY, JSON.stringify(all));
    this.timing = { ...ZERO };
    this.method = 'none';
    this.pending = null;
    this.initialTiming(option);
    this.onChange();
  }

  /** Lines around video time `now` (to pick the one just heard). */
  nearbyLines(now: number, count = 4): TimedCue[] {
    const t = toCue(now, this.timing);
    const i = this.cues.findIndex((c) => c.end > t - 8);
    if (i < 0) return [];
    return this.cues.slice(i, i + count).filter((c) => c.start < t + 12);
  }

  private apply(timing: Timing, method: SyncMethod) {
    this.timing = { offset: timing.offset, ratio: timing.ratio };
    this.method = method;
    const option = this.current;
    if (option) {
      const all = remembered();
      all[this.memoryKey(option)] = { o: timing.offset, r: timing.ratio, m: method, t: Date.now() };
      const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
      for (const k of keys.slice(MAX_REMEMBERED)) delete all[k];
      localStorageSet(TIMING_KEY, JSON.stringify(all));
    }
    this.onChange();
  }

  private memoryKey(option: SubtitleOption) {
    return `${this.videoId}|${option.ref}`;
  }

  /** Label for the menu: "Français 2". */
  label(option: SubtitleOption) {
    const same = this.options.filter((s) => langCode(s.lang) === langCode(option.lang));
    const n = same.length > 1 ? ` ${same.indexOf(option) + 1}` : '';
    return `${languageName(option.lang)}${n}`;
  }

  /** What the menu says about the timing. */
  syncLabel() {
    if (this.syncing) return 'Recherche du bon calage…';
    switch (this.method) {
      case 'file':
        return 'Faits pour ce fichier : déjà synchronisés';
      case 'reference':
        return `Calés sur la version de ce fichier (${formatOffset(this.timing.offset)})`;
      case 'audio':
        return `Synchronisés sur l'audio (${formatOffset(this.timing.offset)})`;
      case 'fps':
        return 'Vitesse corrigée (25 ↔ 23,976 images/s)';
      case 'manual':
        return `Réglage manuel (${formatOffset(this.timing.offset)})`;
      case 'saved':
        return `Réglage retrouvé (${formatOffset(this.timing.offset)})`;
      default:
        return this.auto ? "Écoute de l'audio pour les caler…" : 'Calage d’origine';
    }
  }

  /** Called on every frame tick with the video's own time. */
  render(time: number) {
    const lines = this.selected ? activeCues(this.cues, toCue(time, this.timing)).map((c) => c.text) : [];
    this.show(lines);
  }

  /** Draws these lines (also used for the file's own subtitle tracks). */
  show(lines: string[]) {
    const key = lines.join('\n\n');
    if (key === this.shown) return;
    this.shown = key;
    this.overlay.replaceChildren(...lines.map((text) => h('span', { class: 'subs-cue' }, ...cueNodes(text))));
  }

  private clearSelection() {
    this.seq++;
    this.selected = null;
    this.cues = [];
    this.fileCues = null;
    this.timing = { ...ZERO };
    this.method = 'none';
    this.pending = null;
    this.syncing = false;
    this.loading = false;
    this.show([]);
  }
}

/** "+1,5 s" / "−0,25 s" / "0 s". */
export function formatOffset(seconds: number) {
  const v = Math.round(seconds * 100) / 100;
  if (!v) return '0 s';
  return `${v > 0 ? '+' : '−'}${String(Math.abs(v)).replace('.', ',')} s`;
}

/** Shown time of a line (for the "I heard it" list): "1:02:03". */
export function lineTime(cue: TimedCue, timing: Timing) {
  const t = Math.max(0, Math.floor(toVideo(cue.start, timing)));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/**
 * WebVTT cue text from the file's own tracks → the same safe subset as the server
 * gives (<i>, <b>, <u>, line breaks; everything else dropped, text escaped).
 */
export function cleanVttText(text: string) {
  return text
    .replace(/<(\/?)([ibu])(?:\.[^>\s]*)?\s*>/gi, (_, slash, tag) => `\u0001${slash}${tag.toLowerCase()}\u0002`)
    .replace(/<[^<>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Cue text (only <i>, <b>, <u> and line breaks, already escaped by the server) →
 * DOM nodes, built without innerHTML. Unbalanced tags are ignored.
 */
export function cueNodes(text: string): Node[] {
  const root = document.createDocumentFragment();
  const stack: Node[] = [root];
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const part of text.split(/(<\/?[ibu]>|\n)/)) {
    if (!part) continue;
    const top = stack[stack.length - 1];
    if (part === '\n') top.appendChild(document.createElement('br'));
    else if (/^<[ibu]>$/.test(part)) {
      const el = document.createElement(part[1]);
      top.appendChild(el);
      stack.push(el);
    } else if (/^<\/[ibu]>$/.test(part)) {
      if (stack.length > 1 && (stack[stack.length - 1] as Element).tagName?.toLowerCase() === part[2]) stack.pop();
    } else top.appendChild(document.createTextNode(decode(part)));
  }
  return [...root.childNodes];
}
