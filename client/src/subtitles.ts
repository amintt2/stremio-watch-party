import { api } from './api.ts';
import { localStorageGet, localStorageSet } from './auth.ts';
import { h } from './dom.ts';
import { activeCues, langCode, languageName, type TimedCue } from './format.ts';

export interface SubtitleOption {
  key: string;
  lang: string;
  source: string;
}

/** This viewer's subtitle language ("fr", "en"…), or "" for none. */
const LANG_KEY = 'wp-subs';

/**
 * Subtitles from subtitle addons (OpenSubtitles), chosen by each viewer for
 * themselves and drawn over the video. The file's own tracks stay with hls.js.
 */
export class ExternalSubtitles {
  options: SubtitleOption[] = [];
  /** Key of the selected subtitle, or null. */
  selected: string | null = null;
  /** Seconds added to every cue (OpenSubtitles timing often differs a little). */
  offset = 0;
  loading = false;
  error: string | null = null;
  onChange: () => void = () => {};

  private sid: string | null = null;
  private cues: TimedCue[] = [];
  private shown = '';
  private seq = 0;

  constructor(private readonly overlay: HTMLElement) {}

  get lang() {
    return localStorageGet(LANG_KEY) || '';
  }

  /** New media: fetch its subtitle list and apply the viewer's language. */
  async load(sid: string | null) {
    if (sid === this.sid) return;
    this.sid = sid;
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
      const match = wanted ? items.find((s) => langCode(s.lang) === wanted) : null;
      if (match) await this.select(match.key, false);
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
    this.onChange();
  }

  shift(delta: number) {
    this.offset = Math.round((this.offset + delta) * 10) / 10;
    this.onChange();
  }

  /** Label for the menu: "Français 2 · opensubtitles". */
  label(option: SubtitleOption) {
    const same = this.options.filter((s) => langCode(s.lang) === langCode(option.lang));
    const n = same.length > 1 ? ` ${same.indexOf(option) + 1}` : '';
    return `${languageName(option.lang)}${n}`;
  }

  /** Called on every frame tick with the video's own time. */
  render(time: number) {
    const lines = this.selected ? activeCues(this.cues, time - this.offset).map((c) => c.text) : [];
    const key = lines.join('\n\n');
    if (key === this.shown) return;
    this.shown = key;
    this.overlay.replaceChildren(...lines.map((text) => h('span', { class: 'subs-cue' }, ...cueNodes(text))));
  }

  private clearSelection() {
    this.selected = null;
    this.cues = [];
    this.offset = 0;
    this.loading = false;
    this.render(0);
  }
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
