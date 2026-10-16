import { api, type LibraryItem, type Progress } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h, toast } from '../dom.ts';
import { canResume, progressRatio, relativeTime, routeHref } from '../format.ts';
import { formatTime } from '../sync.ts';
import { emptyState, icon, loadingState, posterCard, progressBar } from '../ui.ts';
import { img } from '../api.ts';

function segmented<T extends string>(label: string, options: [T, string][], value: T, onPick: (v: T) => void) {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([v, text]) => h('button', { type: 'button', class: v === value ? 'active' : '', onclick: () => onPick(v) }, text))
  );
}

export function libraryView(app: App, params: Record<string, string>): View {
  const type = params.type === 'movie' || params.type === 'series' ? params.type : '';
  const sort = params.sort === 'name' ? 'name' : 'recent';
  const go = (next: Record<string, string>) => app.navigate(routeHref('library', { type, sort, ...next }), true);

  const grid = h('div', { class: 'grid' }, loadingState());
  const el = h(
    'div',
    { class: 'page page-library' },
    h(
      'div',
      { class: 'filters' },
      segmented('Type', [['', 'Tout'], ['movie', 'Films'], ['series', 'Séries']], type, (t) => go({ type: t })),
      segmented('Tri', [['recent', 'Récents'], ['name', 'A → Z']], sort, (s) => go({ sort: s }))
    ),
    grid
  );

  api<{ items: LibraryItem[] }>(`/api/library?${new URLSearchParams({ type, sort })}`)
    .then(({ items }) => {
      if (!items.length) {
        clear(
          grid,
          emptyState(
            type ? 'Rien de ce type dans ta bibliothèque' : 'Ta bibliothèque est vide',
            'Ajoute des titres depuis leur fiche avec « Ajouter à la bibliothèque ».',
            h('a', { class: 'btn btn-primary', href: routeHref('discover') }, 'Découvrir')
          )
        );
        return;
      }
      clear(
        grid,
        items.map((item) => {
          const remove: HTMLButtonElement = h(
            'button',
            {
              class: 'card-action',
              type: 'button',
              title: 'Retirer de la bibliothèque',
              'aria-label': `Retirer ${item.name}`,
              onclick: async () => {
                remove.disabled = true;
                try {
                  await api(`/api/library/${item.type}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
                  card.remove();
                } catch (err) {
                  toast((err as Error).message);
                  remove.disabled = false;
                }
              },
            },
            icon('close', 'icon icon-sm')
          );
          const card = posterCard(item, { action: remove });
          return card;
        })
      );
    })
    .catch((err: Error) => clear(grid, emptyState('Bibliothèque indisponible', err.message)));

  return { el };
}

export function historyView(_app: App): View {
  const list = h('div', { class: 'history-list' }, loadingState());
  const el = h('div', { class: 'page page-history' }, h('h1', { class: 'page-title' }, 'Historique'), list);

  api<{ items: Progress[] }>('/api/history')
    .then(({ items }) => {
      if (!items.length) {
        clear(list, emptyState("Tu n'as encore rien regardé", 'Ce que tu regardes apparaîtra ici, avec ta progression.'));
        return;
      }
      clear(
        list,
        items.map((p) => {
          const href = routeHref('detail', { type: p.type, id: p.metaId, video: p.type === 'series' ? p.videoId : null });
          const ratio = progressRatio(p.position, p.duration);
          const resumable = canResume(p);
          const remove: HTMLButtonElement = h(
            'button',
            {
              class: 'btn btn-ghost btn-icon',
              type: 'button',
              title: "Retirer de l'historique",
              'aria-label': `Retirer ${p.name} de l'historique`,
              onclick: async () => {
                remove.disabled = true;
                try {
                  await api(`/api/history/${encodeURIComponent(p.metaId)}`, { method: 'DELETE' });
                  line.remove();
                  if (!list.children.length) clear(list, emptyState('Historique vide'));
                } catch (err) {
                  toast((err as Error).message);
                  remove.disabled = false;
                }
              },
            },
            icon('trash')
          );
          const line = h(
            'div',
            { class: 'history-item' },
            h('a', { class: 'history-poster', href }, p.poster ? h('img', { src: img(p.poster), alt: '', loading: 'lazy' }) : null),
            h(
              'div',
              { class: 'history-text' },
              h('a', { class: 'history-title', href }, p.name),
              h('span', { class: 'muted' }, [p.episode, relativeTime(p.updatedAt)].filter(Boolean).join(' · ')),
              h(
                'span',
                { class: 'history-progress' },
                progressBar(p.watched && !resumable ? 1 : ratio),
                h('span', { class: 'faint small' }, p.watched && !resumable ? 'Vu' : `${formatTime(p.position)} / ${formatTime(p.duration || 0)}`)
              )
            ),
            h(
              'div',
              { class: 'history-actions' },
              h('a', { class: 'btn btn-primary btn-sm', href }, icon('play', 'icon icon-sm'), resumable ? 'Reprendre' : 'Revoir'),
              remove
            )
          );
          return line;
        })
      );
    })
    .catch((err: Error) => clear(list, emptyState('Historique indisponible', err.message)));

  return { el };
}
