import { api, type StreamOption } from './api.ts';
import { clear, h } from './dom.ts';
import { pickBest } from './format.ts';
import { loadingState } from './ui.ts';

type SortMode = 'addon' | 'seeders' | 'size';
const QUALITY_FILTERS = ['Tous', '4K', '1080p', '720p'];
const LANGUAGE_HINTS: Record<string, string> = {
  MULTI: 'VF et VO dans le même fichier : chacun choisit sa langue',
  VF: 'Audio français',
  VOSTFR: 'Version originale, sous-titres français',
};

export function sizeInGb(size: string | null) {
  if (!size) return 0;
  const m = /([\d.]+)\s*([KMGT])/i.exec(size);
  if (!m) return 0;
  const factor = { K: 1e-6, M: 1e-3, G: 1, T: 1e3 }[m[2].toUpperCase() as 'K' | 'M' | 'G' | 'T'];
  return Number(m[1]) * factor;
}

/**
 * Side panel listing the sources of one video (movie or episode), with the quality
 * filter and sort. Clicking a source calls onPick; `best()` serves the one-click buttons.
 */
export class StreamPanel {
  readonly el = h('aside', { class: 'streams', 'aria-label': 'Sources' });
  onPick: (s: StreamOption, button: HTMLButtonElement) => void = () => {};

  private list: StreamOption[] = [];
  private ready: Promise<StreamOption[]> = Promise.resolve([]);
  private seq = 0;
  private sort: SortMode = 'addon';
  private filter = 'Tous';
  private rows = h('div', { class: 'source-list' });
  private title = h('h3', {}, 'Sources');
  private extra = h('div', { class: 'streams-extra' });
  private status = h('div', { class: 'streams-status' });

  constructor() {
    const filters = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Qualité' },
      QUALITY_FILTERS.map((q) =>
        h(
          'button',
          {
            type: 'button',
            class: q === this.filter ? 'active' : '',
            onclick: (e: Event) => {
              this.filter = q;
              filters.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
              (e.currentTarget as HTMLElement).classList.add('active');
              this.render();
            },
          },
          q
        )
      )
    );
    const sortSelect = h(
      'select',
      {
        class: 'input input-sm',
        'aria-label': 'Trier',
        onchange: (e: Event) => {
          this.sort = (e.currentTarget as HTMLSelectElement).value as SortMode;
          this.render();
        },
      },
      h('option', { value: 'addon' }, "Ordre de l'addon"),
      h('option', { value: 'seeders' }, 'Plus de sources'),
      h('option', { value: 'size' }, 'Plus gros fichier')
    );
    this.el.append(
      h('header', { class: 'streams-head' }, this.title, h('div', { class: 'streams-tools' }, filters, sortSelect)),
      this.extra,
      this.status,
      this.rows
    );
    this.empty('Choisis un épisode pour voir ses sources.');
  }

  /** Extra controls above the list (the resume toggle). */
  setExtra(node: HTMLElement | null) {
    clear(this.extra, node);
  }

  empty(text: string) {
    this.list = [];
    this.ready = Promise.resolve([]);
    clear(this.status);
    clear(this.rows, h('p', { class: 'empty' }, text));
  }

  load(type: string, id: string, title: string) {
    const seq = ++this.seq;
    this.title.textContent = title;
    clear(this.status);
    clear(this.rows, loadingState('Recherche des sources…'));
    this.ready = api<{ streams: StreamOption[]; failedAddons: number }>(`/api/streams/${type}/${encodeURIComponent(id)}`)
      .then((res) => {
        if (seq !== this.seq) return this.list;
        this.list = res.streams;
        if (res.failedAddons) clear(this.status, h('p', { class: 'muted small' }, `${res.failedAddons} addon(s) n'ont pas répondu.`));
        if (!this.list.length) {
          clear(this.rows, h('p', { class: 'empty' }, res.failedAddons ? 'Les addons de sources ne répondent pas.' : 'Aucune source trouvée.'));
        } else this.render();
        return this.list;
      })
      .catch((err: Error) => {
        if (seq === this.seq) clear(this.rows, h('p', { class: 'auth-error' }, err.message));
        return [];
      });
    return this.ready;
  }

  async best() {
    return pickBest(await this.ready);
  }

  private render() {
    const visible = this.list.filter((s) => this.filter === 'Tous' || s.quality === this.filter);
    if (this.sort === 'seeders') visible.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
    if (this.sort === 'size') visible.sort((a, b) => sizeInGb(b.size) - sizeInGb(a.size));
    clear(
      this.rows,
      visible.length ? visible.map((s) => this.sourceRow(s)) : h('p', { class: 'empty' }, 'Aucune source dans cette qualité.')
    );
  }

  private sourceRow(s: StreamOption) {
    const badges = [
      s.quality && h('span', { class: 'badge badge-strong' }, s.quality),
      s.hdr && h('span', { class: 'badge' }, s.dolbyVision ? 'DV' : 'HDR'),
      s.hevc && h('span', { class: 'badge' }, 'HEVC'),
      s.cached && h('span', { class: 'badge badge-success' }, '⚡ Débrid'),
      ...(s.languages || []).map((l) =>
        h('span', { class: `badge${l === 'MULTI' ? ' badge-accent' : ''}`, title: LANGUAGE_HINTS[l] }, l)
      ),
    ];
    const facts = [
      s.seeders !== null && h('span', { title: 'Personnes qui partagent' }, `👤 ${s.seeders}`),
      s.size && h('span', {}, `💾 ${s.size}`),
      s.origin && h('span', {}, s.origin),
      h('span', { class: 'faint' }, s.label),
    ];
    return h(
      'button',
      {
        class: 'source',
        type: 'button',
        title: s.release,
        onclick: (e: Event) => this.onPick(s, e.currentTarget as HTMLButtonElement),
      },
      h('span', { class: 'source-badges' }, badges),
      h('span', { class: 'source-release' }, s.release),
      h('span', { class: 'source-facts' }, facts)
    );
  }
}
