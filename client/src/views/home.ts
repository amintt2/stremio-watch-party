import { api, type CatalogDef, type Progress, type SearchResult } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h, toast } from '../dom.ts';
import { routeHref } from '../format.ts';
import { cardButton, emptyState, legalFooter, posterCard, row, skeletonRow } from '../ui.ts';

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

/** Marks the video of a history/continue line as watched. */
export function markProgressWatched(p: Progress) {
  return api('/api/watched', {
    method: 'POST',
    body: JSON.stringify({
      metaId: p.metaId,
      type: p.type,
      name: p.name,
      poster: p.poster,
      watched: true,
      videos: [{ videoId: p.videoId, episode: p.episode }],
    }),
  });
}

/**
 * "Continuer à regarder" card: goes to the title with the video preselected. `onGone`
 * is called once the card left the list (marked watched or dismissed).
 */
export function continueCard(p: Progress, onGone?: () => void) {
  const leave = (card: HTMLElement, message: string) => {
    card.classList.add('leaving');
    window.setTimeout(() => {
      card.remove();
      onGone?.();
    }, 180);
    toast(message);
  };
  const card: HTMLElement = posterCard(
    { id: p.metaId, type: p.type, name: p.name, poster: p.poster, year: null },
    {
      href: routeHref('detail', { type: p.type, id: p.metaId, video: p.type === 'series' ? p.videoId : null }),
      sub: p.episode ? p.episode.split(' · ')[0] : 'Film',
      progress: p,
      actions: [
        cardButton('check', 'Marquer comme vu', async () => {
          try {
            await markProgressWatched(p);
            leave(card, `« ${p.name} » marqué comme vu`);
          } catch (err) {
            toast((err as Error).message);
          }
        }),
        cardButton('close', 'Retirer de « Continuer à regarder »', async () => {
          try {
            await api(`/api/continue/${encodeURIComponent(p.metaId)}`, { method: 'DELETE' });
            leave(card, 'Retiré de « Continuer à regarder » (toujours dans l’historique)');
          } catch (err) {
            toast((err as Error).message);
          }
        }),
      ],
    }
  );
  return card;
}

export function homeView(_app: App): View {
  const continueHost = h('div', { class: 'row-slot' });
  const rows = h('div', { class: 'rows' });
  const el = h('div', { class: 'page page-home' }, continueHost, rows, legalFooter());
  let disposed = false;

  api<{ items: Progress[] }>('/api/continue')
    .then(({ items }) => {
      if (disposed || !items.length) return;
      const r = row(
        'Continuer à regarder',
        items.map((p) =>
          continueCard(p, () => {
            if (!r.querySelector('.row-items .card')) r.remove();
          })
        ),
        routeHref('history')
      );
      clear(continueHost, r);
    })
    .catch(() => {
      /* the catalogs below are still useful */
    });

  const loadCatalogs = () => {
    clear(rows, skeletonRow('Chargement…'), skeletonRow(''));
    getCatalogs()
      .then((catalogs) => {
        if (disposed) return;
        const home = catalogs.filter((c) => c.home);
        if (!home.length) {
          clear(rows, emptyState('Aucun catalogue', "L'addon de métadonnées n'en propose pas."));
          return;
        }
        clear(rows);
        let failed = 0;
        for (const c of home) {
          const slot = skeletonRow(catalogTitle(c));
          rows.append(slot);
          api<{ metas: SearchResult[] }>(`/api/catalog/${c.type}/${encodeURIComponent(c.id)}`)
            .then(({ metas }) => {
              if (!metas.length) return slot.remove();
              slot.replaceWith(row(catalogTitle(c), metas.slice(0, 30).map((m) => posterCard(m)), routeHref('discover', { type: c.type, catalog: c.id })));
            })
            .catch(() => {
              slot.remove();
              if (++failed === home.length && !disposed) retryState('Catalogues indisponibles', "L'addon de métadonnées ne répond pas.");
            });
        }
      })
      .catch((err: Error) => retryState('Catalogues indisponibles', err.message));
  };
  const retryState = (title: string, text: string) =>
    clear(rows, emptyState(title, text, h('button', { class: 'btn btn-primary', type: 'button', onclick: loadCatalogs }, 'Réessayer')));
  loadCatalogs();

  return { el, dispose: () => (disposed = true) };
}
