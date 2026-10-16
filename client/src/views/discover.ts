import { api, type CatalogDef, type MetaType, type SearchResult } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h } from '../dom.ts';
import { routeHref } from '../format.ts';
import { emptyState, loadingState, posterCard } from '../ui.ts';
import { catalogTitle, getCatalogs } from './home.ts';

/** Grid of one catalog with type / catalog / genre filters and infinite scroll. */
export function discoverView(app: App, params: Record<string, string>): View {
  const filters = h('div', { class: 'filters' });
  const grid = h('div', { class: 'grid' });
  const status = h('div', { class: 'grid-status' });
  const sentinel = h('div', { class: 'sentinel' });
  const el = h('div', { class: 'page page-discover' }, filters, grid, status, sentinel);

  let observer: IntersectionObserver | null = null;
  let disposed = false;

  getCatalogs()
    .then((catalogs) => {
      if (disposed) return;
      const type: MetaType = params.type === 'series' ? 'series' : 'movie';
      const ofType = catalogs.filter((c) => c.type === type);
      const current = ofType.find((c) => c.id === params.catalog) || ofType[0];
      if (!current) {
        clear(grid, emptyState('Aucun catalogue pour ce type'));
        return;
      }
      const genre = current.genres.includes(params.genre) ? params.genre : current.genreRequired ? current.genres[0] : '';
      const go = (next: { type?: string; catalog?: string; genre?: string }) =>
        app.navigate(routeHref('discover', { type, catalog: current.id, genre, ...next }), true);

      const typeSwitch = h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Type' },
        (['movie', 'series'] as const).map((t) =>
          h('button', { type: 'button', class: t === type ? 'active' : '', onclick: () => go({ type: t, catalog: '', genre: '' }) }, t === 'movie' ? 'Films' : 'Séries')
        )
      );
      const catalogSel = h(
        'select',
        { class: 'input', 'aria-label': 'Catalogue', onchange: (e: Event) => go({ catalog: (e.currentTarget as HTMLSelectElement).value, genre: '' }) },
        ofType.map((c: CatalogDef) => h('option', { value: c.id }, catalogTitle(c)))
      );
      catalogSel.value = current.id;
      const genreSel = h(
        'select',
        { class: 'input', 'aria-label': 'Genre', onchange: (e: Event) => go({ genre: (e.currentTarget as HTMLSelectElement).value }) },
        current.genreRequired ? null : h('option', { value: '' }, 'Tous les genres'),
        current.genres.map((g) => h('option', { value: g }, g))
      );
      genreSel.value = genre;
      genreSel.hidden = !current.genres.length;
      clear(filters, typeSwitch, catalogSel, genreSel);

      // ---- paging
      const seen = new Set<string>();
      let loading = false;
      let done = false;
      const loadMore = async () => {
        if (loading || done || disposed) return;
        loading = true;
        clear(status, loadingState());
        try {
          const q = new URLSearchParams();
          if (genre) q.set('genre', genre);
          if (seen.size) q.set('skip', String(seen.size));
          const { metas } = await api<{ metas: SearchResult[] }>(`/api/catalog/${type}/${encodeURIComponent(current.id)}?${q}`);
          if (disposed) return;
          const fresh = metas.filter((m) => !seen.has(m.id));
          fresh.forEach((m) => seen.add(m.id));
          grid.append(...fresh.map((m) => posterCard(m)));
          if (!fresh.length || !current.skip) done = true;
          clear(status, done && !seen.size ? emptyState('Rien ici', 'Essaie un autre genre.') : null);
        } catch (err) {
          clear(status, h('p', { class: 'auth-error' }, (err as Error).message));
          done = true;
        } finally {
          loading = false;
        }
        // Still room on screen (large displays): keep filling.
        if (!done && sentinel.getBoundingClientRect().top < window.innerHeight + 400) loadMore();
      };
      observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), {
        root: el.closest('.content'),
        rootMargin: '600px',
      });
      observer.observe(sentinel);
      loadMore();
    })
    .catch((err: Error) => clear(grid, emptyState('Catalogues indisponibles', err.message)));

  return {
    el,
    dispose: () => {
      disposed = true;
      observer?.disconnect();
    },
  };
}
