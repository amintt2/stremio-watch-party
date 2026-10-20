import { api, type StreamOption } from './api.ts';
import { clear, h } from './dom.ts';
import { pickBest } from './format.ts';
import { getMusts, launchPrefs, meets, MUSTS, mustsLabel, onMustsChange, toggleMust } from './musts.ts';
import { localStorageGet, localStorageSet } from './storage.ts';
import { icon, loadingState } from './ui.ts';

type SortMode = 'addon' | 'seeders' | 'size';
/** The viewer opened the hand-picked list once: keep it open. */
const MANUAL_KEY = 'wp-sources-manual';
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
 * The obligations under "Lire" (VF + VO, ST FR, 1080p+…): chips that switch on and off,
 * the same everywhere on the page.
 */
export function mustRow() {
  const row = h('div', { class: 'must-row', role: 'group', 'aria-label': 'Obligatoire pour « Lire »' });
  const render = () => {
    const on = getMusts();
    clear(
      row,
      MUSTS.map((m) =>
        h(
          'button',
          {
            type: 'button',
            class: `must-chip${on.includes(m.id) ? ' on' : ''}`,
            title: m.hint,
            'aria-pressed': on.includes(m.id) ? 'true' : 'false',
            onclick: () => toggleMust(m.id),
          },
          m.label
        )
      )
    );
  };
  render();
  const off = onMustsChange(() => (row.isConnected ? render() : off()));
  return row;
}

/**
 * Side panel listing the sources of one video (movie or episode), with the quality
 * filter and sort. Its big "Lire" button (onAuto) is the normal way to start: the server
 * races the sources. The list, folded by default, is for picking one by hand (onPick).
 */
export class StreamPanel {
  readonly el = h('aside', { class: 'streams', 'aria-label': 'Sources' });
  onPick: (s: StreamOption, button: HTMLButtonElement) => void = () => {};
  /** "Lire": the server tests every source at once and plays the fastest (like Huwa). */
  onAuto: (button: HTMLButtonElement) => void = () => {};

  private list: StreamOption[] = [];
  private ready: Promise<StreamOption[]> = Promise.resolve([]);
  private seq = 0;
  private sort: SortMode = 'addon';
  private filter = 'Tous';
  private rows = h('div', { class: 'source-list' });
  private title = h('h3', {}, 'Sources');
  private extra = h('div', { class: 'streams-extra' });
  private status = h('div', { class: 'streams-status' });
  private autoBtn: HTMLButtonElement = h(
    'button',
    { class: 'btn btn-primary btn-lg streams-auto', type: 'button', onclick: () => this.onAuto(this.autoBtn) },
    icon('play'),
    'Lire'
  );
  private autoHint = h('p', { class: 'muted small streams-auto-hint' }, 'Teste toutes les sources en même temps et lance la plus rapide.');
  /** Your defaults (your last choices in the player), applied when it starts. */
  private prefs = h('p', { class: 'small streams-prefs', title: 'Tes derniers choix dans le lecteur : appliqués au prochain film. Change-les pendant la lecture.' });
  /** Picking a source by hand is the exception: the list stays folded unless opened. */
  private manual = h('details', { class: 'streams-manual' });
  private manualSummary = h('summary', {}, 'Choisir une source moi-même');

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
    this.manual.open = localStorageGet(MANUAL_KEY) === '1';
    this.manual.addEventListener('toggle', () => localStorageSet(MANUAL_KEY, this.manual.open ? '1' : '0'));
    // The extra toggles (start or propose a picked source, from where) are about the list.
    this.manual.append(this.manualSummary, this.extra, h('div', { class: 'streams-tools' }, filters, sortSelect), this.status, this.rows);
    this.el.append(h('header', { class: 'streams-head' }, this.title), this.autoBtn, mustRow(), this.autoHint, this.prefs, this.manual);
    this.prefs.textContent = `Pour toi : ${launchPrefs()}`;
    const off = onMustsChange(() => {
      if (!this.el.isConnected && this.list.length) return off();
      this.refreshAuto();
      if (this.list.length) this.render();
    });
    this.empty('Choisis un épisode pour voir ses sources.');
  }

  /** Extra controls above the list (the resume toggle). */
  setExtra(node: HTMLElement | null) {
    clear(this.extra, node);
  }

  /** The big button follows what is known about the sources (and the obligations). */
  private setAuto(state: 'loading' | 'ready' | 'none', count = 0) {
    this.autoState = state;
    this.autoBtn.disabled = state !== 'ready';
    this.manualSummary.textContent = state === 'ready' ? `Choisir une source moi-même (${count})` : 'Choisir une source moi-même';
    if (state !== 'ready') {
      this.autoHint.textContent = state === 'loading' ? 'Recherche des sources…' : 'Aucune source pour lancer.';
      return;
    }
    const musts = getMusts();
    const fit = this.usable().filter((s) => meets(s, musts)).length;
    if (!musts.length) this.autoHint.textContent = count > 1 ? `Teste les ${count} sources en même temps et lance la plus rapide.` : 'Vérifie la source et la lance.';
    else if (fit > 1) this.autoHint.textContent = `Teste les ${fit} sources sur ${count} qui ont : ${mustsLabel(musts)}.`;
    else if (fit) this.autoHint.textContent = `Une source sur ${count} a : ${mustsLabel(musts)}.`;
    else {
      this.autoHint.textContent = `Aucune source avec : ${mustsLabel(musts)}. Décoche un critère.`;
      this.autoBtn.disabled = true;
    }
  }

  private autoState: 'loading' | 'ready' | 'none' = 'none';

  private usable() {
    return this.list.filter((s) => !s.tooBig);
  }

  private refreshAuto() {
    if (this.autoState === 'ready') this.setAuto('ready', this.usable().length);
  }

  empty(text: string) {
    this.setAuto('none');
    this.list = [];
    this.ready = Promise.resolve([]);
    clear(this.status);
    clear(this.rows, h('p', { class: 'empty' }, text));
  }

  load(type: string, id: string, title: string) {
    const seq = ++this.seq;
    // The previous video's sources must not be played (or listed) for this one.
    this.list = [];
    this.title.textContent = title;
    clear(this.status);
    clear(this.rows, loadingState('Recherche des sources…'));
    this.setAuto('loading');
    this.ready = api<{ streams: StreamOption[]; failedAddons: number }>(`/api/streams/${type}/${encodeURIComponent(id)}`)
      .then((res) => {
        if (seq !== this.seq) return this.list;
        this.list = res.streams;
        const usable = this.list.filter((s) => !s.tooBig).length;
        this.setAuto(usable ? 'ready' : 'none', usable);
        if (res.failedAddons) clear(this.status, h('p', { class: 'muted small' }, `${res.failedAddons} addon(s) n'ont pas répondu.`));
        if (!this.list.length) {
          clear(this.rows, h('p', { class: 'empty' }, res.failedAddons ? 'Les addons de sources ne répondent pas.' : 'Aucune source trouvée.'));
        } else this.render();
        return this.list;
      })
      .catch((err: Error) => {
        if (seq === this.seq) {
          clear(this.rows, h('p', { class: 'auth-error' }, err.message));
          this.setAuto('none');
          this.manual.open = true;
        }
        return [];
      });
    return this.ready;
  }

  async best() {
    return pickBest((await this.ready).filter((s) => !s.tooBig));
  }

  /** Every usable source that meets the obligations, for the automatic choice (the server tests them). */
  async candidates() {
    const musts = getMusts();
    return (await this.ready).filter((s) => !s.tooBig && meets(s, musts)).map((s) => s.key);
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
      s.tooBig && h('span', { class: 'badge badge-danger' }, 'Trop gros'),
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
        class: `source${s.tooBig ? ' source-too-big' : ''}${meets(s, getMusts()) ? '' : ' source-unmet'}`,
        type: 'button',
        disabled: !!s.tooBig,
        title: s.tooBig ? `${s.release}\nTrop gros pour le stockage du serveur : choisis une source plus légère` : s.release,
        onclick: (e: Event) => this.onPick(s, e.currentTarget as HTMLButtonElement),
      },
      h('span', { class: 'source-badges' }, badges),
      h('span', { class: 'source-release' }, s.release),
      h('span', { class: 'source-facts' }, facts)
    );
  }
}
