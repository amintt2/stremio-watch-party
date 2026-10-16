import { api, type CatalogDef, type SearchResult } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h } from '../dom.ts';
import { routeHref } from '../format.ts';
import { discoverState, sortLabel } from '../lists.ts';
import { emptyState, posterCard, segmented, skeletonGrid } from '../ui.ts';
import { catalogTitle, getCatalogs } from './home.ts';

/**
 * Grid of one catalog with type / sort (= catalog) / genre / year filters, all kept in
 * the URL, and infinite scroll.
 */
export function discoverView(app: App, params: Record<string, string>): View {
  const filters = h('div', { class: 'filters' });
  const count = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const grid = h('div', { class: 'grid' }, skeletonGrid());
  const status = h('div', { class: 'grid-status' });
  const sentinel = h('div', { class: 'sentinel' });
  const el = h('div', { class: 'page page-discover' }, h('h1', { class: 'visually-hidden' }, 'Découvrir'), filters, count, grid, status, sentinel);

  let observer: IntersectionObserver | null = null;
  let disposed = false;

  const start = () =>
    getCatalogs()
      .then((catalogs) => {
        if (!disposed) show(catalogs);
      })
      .catch((err: Error) =>
        clear(grid, emptyState('Catalogues indisponibles', err.message, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (clear(grid, skeletonGrid()), start()) }, 'Réessayer')))
      );

  function show(catalogs: CatalogDef[]) {
    const { type, catalog: current, genre, byYear, yearCatalog } = discoverState(catalogs, params);
    const go = (next: { type?: string; catalog?: string; genre?: string }) =>
      app.navigate(routeHref('discover', { type, catalog: current?.id, genre, ...next }), true);

    const typeSwitch = segmented('Type', [['movie', 'Films'], ['series', 'Séries']], type, (t) => go({ type: t, catalog: '', genre: '' }));
    if (!current) {
      clear(filters, typeSwitch);
      clear(grid, emptyState('Aucun catalogue pour ce type'));
      return;
    }
    const ofType = catalogs.filter((c) => c.type === type);

    // Sort: each catalog of the meta addon is one ordering (popularity, year, rating…).
    const labels = ofType.map(sortLabel);
    const distinct = new Set(labels).size === labels.length && ofType.length <= 4;
    const sortControl = distinct
      ? h(
          'div',
          { class: 'filter-group' },
          h('span', { class: 'filter-label' }, 'Trier par'),
          segmented('Trier par', ofType.map((c, i) => [c.id, labels[i]] as [string, string]), current.id, (id) => go({ catalog: id, genre: '' }))
        )
      : h(
          'select',
          { class: 'input', 'aria-label': 'Catalogue', onchange: (e: Event) => go({ catalog: (e.currentTarget as HTMLSelectElement).value, genre: '' }) },
          ofType.map((c) => h('option', { value: c.id, selected: c.id === current.id }, catalogTitle(c)))
        );

    const genreSel = h(
      'select',
      {
        class: 'input',
        'aria-label': byYear ? 'Année' : 'Genre',
        onchange: (e: Event) => go({ genre: (e.currentTarget as HTMLSelectElement).value }),
      },
      current.genreRequired ? null : h('option', { value: '' }, byYear ? 'Toutes les années' : 'Tous les genres'),
      current.genres.map((g) => h('option', { value: g }, g))
    );
    genreSel.value = genre;

    // Year filter on the other orderings: jumps to the catalog listed by year.
    const yearSel = yearCatalog
      ? h(
          'select',
          {
            class: 'input',
            'aria-label': 'Année',
            onchange: (e: Event) => {
              const y = (e.currentTarget as HTMLSelectElement).value;
              if (y) go({ catalog: yearCatalog.id, genre: y });
            },
          },
          h('option', { value: '' }, 'Toutes les années'),
          yearCatalog.genres.map((g) => h('option', { value: g }, g))
        )
      : null;

    const resetBtn =
      genre && !current.genreRequired
        ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => go({ genre: '' }) }, 'Effacer le filtre')
        : null;
    clear(filters, typeSwitch, sortControl, current.genres.length ? genreSel : null, yearSel, resetBtn);

    // ---- paging
    const seen = new Set<string>();
    let loading = false;
    let done = false;
    let first = true;
    const renderCount = () => {
      count.textContent = seen.size ? `${seen.size}${done ? '' : '+'} titre${seen.size > 1 ? 's' : ''}` : '';
    };
    const loadMore = async () => {
      if (loading || done || disposed) return;
      loading = true;
      if (!first) clear(status, h('div', { class: 'grid' }, skeletonGrid(6)));
      try {
        const q = new URLSearchParams();
        if (genre) q.set('genre', genre);
        if (seen.size) q.set('skip', String(seen.size));
        const { metas } = await api<{ metas: SearchResult[] }>(`/api/catalog/${type}/${encodeURIComponent(current.id)}?${q}`);
        if (disposed) return;
        if (first) clear(grid);
        first = false;
        const fresh = metas.filter((m) => !seen.has(m.id));
        fresh.forEach((m) => seen.add(m.id));
        grid.append(...fresh.map((m) => posterCard(m)));
        if (!fresh.length || !current.skip) done = true;
        clear(
          status,
          done && !seen.size
            ? emptyState('Rien ici', byYear ? 'Essaie une autre année.' : 'Essaie un autre genre.', genre && !current.genreRequired ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go({ genre: '' }) }, 'Voir tout') : undefined)
            : done && seen.size > 20
              ? h('p', { class: 'empty small' }, 'Tu as tout vu.')
              : null
        );
      } catch (err) {
        if (first) clear(grid);
        clear(
          status,
          emptyState(
            'Chargement impossible',
            (err as Error).message,
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ((done = false), loadMore()) }, 'Réessayer')
          )
        );
        done = true;
      } finally {
        loading = false;
        renderCount();
      }
      // Still room on screen (large displays): keep filling.
      if (!done && el.isConnected && sentinel.getBoundingClientRect().top < window.innerHeight + 400) loadMore();
    };
    observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), {
      root: el.closest('.content'),
      rootMargin: '600px',
    });
    observer.observe(sentinel);
    loadMore();
  }

  start();
  return {
    el,
    dispose: () => {
      disposed = true;
      observer?.disconnect();
    },
  };
}
