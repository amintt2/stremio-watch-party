import { img, type Member, type SearchResult } from './api.ts';
import { h } from './dom.ts';
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
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" fill="currentColor"/>',
  logout: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10"/>',
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
    opts.progress ? progressBar(progressRatio(opts.progress.position, opts.progress.duration), 'progress progress-poster') : null
  );
  return h(
    'div',
    { class: 'card' },
    h('a', { class: 'card-link', href, title: item.name }, poster, h('span', { class: 'card-title' }, item.name), sub ? h('span', { class: 'card-sub' }, sub) : null),
    opts.action || null
  );
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

export function skeletonRow(title: string, n = 8) {
  return row(title, Array.from({ length: n }, () => h('div', { class: 'card skeleton' }, h('span', { class: 'poster' }))));
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
