import { api, type SearchResult } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h } from '../dom.ts';
import { emptyState, posterCard, row, skeletonRow } from '../ui.ts';

export function searchView(_app: App, params: Record<string, string>): View {
  const q = (params.q || '').trim();
  const el = h('div', { class: 'page page-search' });
  if (q.length < 2) {
    clear(el, emptyState('Recherche', 'Tape au moins 2 lettres dans la barre du haut.'));
    return { el };
  }
  let disposed = false;
  clear(el, skeletonRow(`Résultats pour « ${q} »`));
  api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`)
    .then(({ results }) => {
      if (disposed) return;
      const movies = results.filter((r) => r.type === 'movie');
      const series = results.filter((r) => r.type === 'series');
      if (!results.length) {
        clear(el, emptyState(`Aucun résultat pour « ${q} »`));
        return;
      }
      clear(
        el,
        movies.length ? row('Films', movies.map((m) => posterCard(m))) : null,
        series.length ? row('Séries', series.map((m) => posterCard(m))) : null
      );
    })
    .catch((err: Error) => clear(el, emptyState('Recherche impossible', err.message)));
  return { el, dispose: () => (disposed = true) };
}
