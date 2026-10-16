import { api, type CatalogDef, type Progress, type SearchResult } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h } from '../dom.ts';
import { routeHref } from '../format.ts';
import { emptyState, legalFooter, posterCard, row, skeletonRow } from '../ui.ts';

let catalogsPromise: Promise<CatalogDef[]> | null = null;

/** The meta addon's catalogs (from its manifest), fetched once. */
export function getCatalogs() {
  catalogsPromise ??= api<{ catalogs: CatalogDef[] }>('/api/catalogs')
    .then((r) => r.catalogs)
    .catch((err) => {
      catalogsPromise = null;
      throw err;
    });
  return catalogsPromise;
}

export function catalogTitle(c: CatalogDef) {
  const kind = c.type === 'movie' ? 'Films' : 'Séries';
  const names: Record<string, string> = { Popular: 'populaires', New: 'récents', Featured: 'à la une' };
  return names[c.name] ? `${kind} ${names[c.name]}` : `${c.name} · ${kind}`;
}

/** "Continuer à regarder" card: goes to the title with the video preselected. */
export function continueCard(p: Progress) {
  return posterCard(
    { id: p.metaId, type: p.type, name: p.name, poster: p.poster, year: null },
    {
      href: routeHref('detail', { type: p.type, id: p.metaId, video: p.type === 'series' ? p.videoId : null }),
      sub: p.episode ? p.episode.split(' · ')[0] : 'Film',
      progress: p,
    }
  );
}

export function homeView(_app: App): View {
  const continueHost = h('div', { class: 'row-slot' });
  const rows = h('div', { class: 'rows' });
  const el = h('div', { class: 'page page-home' }, continueHost, rows, legalFooter());

  api<{ items: Progress[] }>('/api/continue')
    .then(({ items }) => {
      if (items.length) clear(continueHost, row('Continuer à regarder', items.map(continueCard), routeHref('history')));
    })
    .catch(() => {});

  clear(rows, skeletonRow('Chargement…'), skeletonRow(''));
  getCatalogs()
    .then((catalogs) => {
      const home = catalogs.filter((c) => c.home);
      if (!home.length) {
        clear(rows, emptyState('Aucun catalogue', "L'addon de métadonnées n'en propose pas."));
        return;
      }
      clear(rows);
      for (const c of home) {
        const slot = skeletonRow(catalogTitle(c));
        rows.append(slot);
        api<{ metas: SearchResult[] }>(`/api/catalog/${c.type}/${encodeURIComponent(c.id)}`)
          .then(({ metas }) => {
            if (!metas.length) return slot.remove();
            slot.replaceWith(row(catalogTitle(c), metas.slice(0, 30).map((m) => posterCard(m)), routeHref('discover', { type: c.type, catalog: c.id })));
          })
          .catch(() => slot.remove());
      }
    })
    .catch((err: Error) => clear(rows, emptyState('Catalogues indisponibles', err.message)));

  return { el };
}
