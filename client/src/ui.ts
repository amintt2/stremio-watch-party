import { img, type Member, type SearchResult } from './api.ts';
import { openExternal } from './auth.ts';
import { h, toast } from './dom.ts';
import { progressRatio, routeHref } from './format.ts';

// Line icons (24×24, stroke = currentColor), drawn for this app.
const ICONS: Record<string, string> = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
  discover: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  library: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4h4"/><path d="M12 7.5V12l3 2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  'volume-low': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  'fullscreen-exit': '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  audio: '<path d="M4.5 15.5V12a7.5 7.5 0 0 1 15 0v3.5"/><rect x="3.5" y="14" width="4" height="6" rx="1.5"/><rect x="16.5" y="14" width="4" height="6" rx="1.5"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.6 10.3a2.4 2.4 0 1 0 0 3.4M17.1 10.3a2.4 2.4 0 1 0 0 3.4"/>',
  'caret-down': '<path d="m7.5 10 4.5 4.5 4.5-4.5"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" fill="currentColor"/>',
  logout: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.8 3.6M6.5 7.6A15.6 15.6 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  next: '<path d="M5 5.5v13l9.5-6.5z" fill="currentColor"/><path d="M18 5.5v13"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v5.5H4.5V6H10"/>',
  trailer: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9v6l5-3z" fill="currentColor"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

export function icon(name: keyof typeof ICONS | string, cls = 'icon') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

export function progressBar(ratio: number, cls = 'progress') {
  const bar = h('span', { class: cls, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(ratio * 100) });
  bar.append(h('span', { style: `width:${(ratio * 100).toFixed(1)}%` }));
  return bar;
}

export interface CardOptions {
  href?: string;
  /** e.g. "S1E02" or "Film" */
  sub?: string | null;
  progress?: { position: number; duration: number | null } | null;
  action?: HTMLElement | null;
  /** Several small round buttons over the poster (see cardButton). */
  actions?: HTMLElement[];
  /** Small badge over the poster, e.g. "Vu". */
  badge?: string | null;
}

/** Poster tile, the building block of every list. */
export function posterCard(item: SearchResult, opts: CardOptions = {}) {
  const href = opts.href || routeHref('detail', { type: item.type, id: item.id });
  const sub = opts.sub !== undefined ? opts.sub : [item.year, item.type === 'series' ? 'Série' : 'Film'].filter(Boolean).join(' · ');
  const poster = h(
    'span',
    { class: 'poster' },
    item.poster
      ? h('img', { src: img(item.poster), alt: '', loading: 'lazy', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() })
      : null,
    h('span', { class: 'poster-ph' }, item.name),
    item.rating ? h('span', { class: 'poster-rating' }, icon('star', 'icon icon-xs'), item.rating) : null,
    opts.badge ? h('span', { class: 'poster-badge' }, icon('check', 'icon icon-xs'), opts.badge) : null,
    opts.progress ? progressBar(progressRatio(opts.progress.position, opts.progress.duration), 'progress progress-poster') : null
  );
  return h(
    'div',
    { class: 'card' },
    h('a', { class: 'card-link', href, title: item.name }, poster, h('span', { class: 'card-title' }, item.name), sub ? h('span', { class: 'card-sub' }, sub) : null),
    opts.action || null,
    opts.actions?.length ? h('div', { class: 'card-actions' }, opts.actions) : null
  );
}

/** Round button over a poster (inside CardOptions.actions). */
export function cardButton(iconName: string, label: string, onclick: (button: HTMLButtonElement) => void | Promise<void>) {
  const button: HTMLButtonElement = h(
    'button',
    {
      class: 'card-btn',
      type: 'button',
      title: label,
      'aria-label': label,
      onclick: async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        button.disabled = true;
        try {
          await onclick(button);
        } finally {
          button.disabled = false;
        }
      },
    },
    icon(iconName, 'icon icon-sm')
  );
  return button;
}

/** Horizontal, scrollable row with a title and an optional "see all" link. */
export function row(title: string, items: HTMLElement[] | HTMLElement, more?: string) {
  return h(
    'section',
    { class: 'row' },
    h('header', { class: 'row-head' }, h('h2', {}, title), more ? h('a', { class: 'row-more', href: more }, 'Voir tout') : null),
    h('div', { class: 'row-items' }, items)
  );
}

const skeletonCard = () =>
  h('div', { class: 'card skeleton', 'aria-hidden': 'true' }, h('span', { class: 'poster' }), h('span', { class: 'skeleton-line' }), h('span', { class: 'skeleton-line short' }));

export function skeletonRow(title: string, n = 8) {
  const r = row(title, Array.from({ length: n }, skeletonCard));
  r.setAttribute('aria-busy', 'true');
  return r;
}

/** Placeholder grid while a list loads. */
export function skeletonGrid(n = 12) {
  return Array.from({ length: n }, skeletonCard);
}

/** Placeholder lines (history). */
export function skeletonLines(n = 5) {
  return Array.from({ length: n }, () =>
    h('div', { class: 'history-item skeleton', 'aria-hidden': 'true' }, h('span', { class: 'history-poster' }), h('span', { class: 'skeleton-text' }, h('span', { class: 'skeleton-line' }), h('span', { class: 'skeleton-line short' })))
  );
}

/** Placeholder of a title page. */
export function skeletonDetail() {
  return h(
    'div',
    { class: 'detail-layout skeleton', 'aria-busy': 'true', 'aria-label': 'Chargement' },
    h(
      'div',
      { class: 'detail-hero' },
      h('span', { class: 'detail-poster skeleton-block' }),
      h('div', { class: 'skeleton-text' }, h('span', { class: 'skeleton-line big' }), h('span', { class: 'skeleton-line' }), h('span', { class: 'skeleton-line' }), h('span', { class: 'skeleton-line short' }))
    ),
    h('span', { class: 'streams skeleton-block' })
  );
}

/** Segmented buttons ("Tout · Films · Séries"); a count is shown after each label when given. */
export function segmented<T extends string>(label: string, options: [T, string, number?][], value: T, onPick: (v: T) => void) {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([v, text, count]) =>
      h(
        'button',
        { type: 'button', class: v === value ? 'active' : '', 'aria-pressed': v === value ? 'true' : 'false', onclick: () => onPick(v) },
        text,
        count !== undefined ? h('span', { class: 'count' }, String(count)) : null
      )
    )
  );
}

/**
 * Button that asks to click again to confirm (the Discord iframe blocks confirm()).
 * The label turns into `confirmLabel` for 4 s.
 */
export function confirmButton(attrs: { class: string; label: string; confirmLabel: string; icon?: string; title?: string }, action: () => Promise<void> | void) {
  let armed = 0;
  let timer = 0;
  const text = h('span', { class: 'btn-label' }, attrs.label);
  const reset = () => {
    armed = 0;
    text.textContent = attrs.label;
    button.classList.remove('armed');
  };
  const button: HTMLButtonElement = h(
    'button',
    {
      class: attrs.class,
      type: 'button',
      title: attrs.title || null,
      onclick: async () => {
        clearTimeout(timer);
        if (!armed) {
          armed = Date.now();
          text.textContent = attrs.confirmLabel;
          button.classList.add('armed');
          timer = window.setTimeout(reset, 4000);
          return;
        }
        reset();
        button.disabled = true;
        try {
          await action();
        } catch (err) {
          toast((err as Error).message);
        } finally {
          button.disabled = false;
        }
      },
      onblur: () => armed && window.setTimeout(reset, 200),
    },
    attrs.icon ? icon(attrs.icon, 'icon icon-sm') : null,
    text
  );
  return button;
}

/**
 * Copies to the clipboard; the Discord iframe may refuse it, so falls back to
 * execCommand, then shows the text so it can be copied by hand.
 */
export async function copyText(text: string, okMessage = 'Copié') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
    return;
  } catch {
    /* blocked: try the old way */
  }
  const area = h('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  toast(ok ? okMessage : `Copie impossible ici, voici le lien : ${text}`);
}

export function emptyState(title: string, text?: string, action?: HTMLElement) {
  return h('div', { class: 'empty-state' }, h('p', { class: 'empty-title' }, title), text ? h('p', { class: 'muted' }, text) : null, action || null);
}

export function loadingState(text = 'Chargement…') {
  return h('p', { class: 'empty' }, h('span', { class: 'spinner' }), text);
}

export function avatar(m: Pick<Member, 'name' | 'avatar'>, cls = 'avatar') {
  return h(
    'span',
    { class: cls, title: m.name },
    m.avatar ? h('img', { src: img(m.avatar), alt: '' }) : h('span', { class: 'avatar-initial' }, m.name.slice(0, 1).toUpperCase())
  );
}

/** Terms + privacy links; inside Discord they must open through the SDK. */
export function legalFooter() {
  const link = (label: string, href: string) => h('a', { href, onclick: (e: Event) => (e.preventDefault(), openExternal(href)) }, label);
  return h('footer', { class: 'legal' }, link('Conditions d’utilisation', '/conditions'), ' · ', link('Confidentialité', '/confidentialite'));
}
