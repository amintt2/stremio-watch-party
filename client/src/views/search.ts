import { api, type SearchResult } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h } from '../dom.ts';
import { routeHref } from '../format.ts';
import { parseResultSort, RESULT_SORTS, sortResults, typeCounts, type ResultSort } from '../lists.ts';
import { emptyState, posterCard, segmented, skeletonGrid } from '../ui.ts';

/** Search results as a grid, filterable by type and sortable; filters live in the URL. */
export function searchView(app: App, params: Record<string, string>): View {
  const q = (params.q || '').trim();
  const el = h('div', { class: 'page page-search' });
  if (q.length < 2) {
    clear(
      el,
      emptyState(
        'Recherche',
        'Tape au moins 2 lettres dans la barre du haut (raccourci : touche /).',
        h('a', { class: 'btn btn-ghost', href: routeHref('discover') }, 'Parcourir le catalogue')
      )
    );
    return { el };
  }
  let disposed = false;
  let type = params.type === 'movie' || params.type === 'series' ? params.type : '';
  let sort: ResultSort = parseResultSort(params.sort);

  const title = h('h1', { class: 'page-title' }, `Résultats pour « ${q} »`);
  const filters = h('div', { class: 'filters' });
  const count = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const grid = h('div', { class: 'grid' }, skeletonGrid());
  clear(el, h('header', { class: 'page-head' }, title), filters, count, grid);

  const load = () =>
    api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`)
      .then(({ results }) => {
        if (disposed) return;
        if (!results.length) {
          clear(filters);
          clear(
            grid,
            emptyState(
              `Aucun résultat pour « ${q} »`,
              'Vérifie l’orthographe, ou cherche le titre original (souvent en anglais).',
              h('a', { class: 'btn btn-ghost', href: routeHref('discover') }, 'Parcourir le catalogue')
            )
          );
          return;
        }
        const render = () => {
          const counts = typeCounts(results);
          clear(
            filters,
            segmented(
              'Type',
              [
                ['', 'Tout', counts.all],
                ['movie', 'Films', counts.movie],
                ['series', 'Séries', counts.series],
              ],
              type,
              (t) => {
                type = t;
                update();
              }
            ),
            h(
              'div',
              { class: 'filter-group' },
              h('span', { class: 'filter-label' }, 'Trier par'),
              segmented('Trier par', RESULT_SORTS, sort, (s) => {
                sort = s;
                update();
              })
            )
          );
          const shown = sortResults(results, { type, sort });
          count.textContent = `${shown.length} résultat${shown.length > 1 ? 's' : ''}`;
          clear(grid, shown.length ? shown.map((m) => posterCard(m)) : emptyState(type === 'movie' ? 'Aucun film' : 'Aucune série', 'Essaie l’autre type.'));
        };
        const update = () => {
          app.replaceRoute(routeHref('search', { q, type, sort: sort === 'relevance' ? '' : sort }));
          render();
        };
        render();
      })
      .catch((err: Error) => {
        if (disposed) return;
        clear(
          grid,
          emptyState(
            'Recherche impossible',
            err.message,
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (clear(grid, skeletonGrid()), load()) }, 'Réessayer')
          )
        );
      });
  load();
  return { el, dispose: () => (disposed = true) };
}
