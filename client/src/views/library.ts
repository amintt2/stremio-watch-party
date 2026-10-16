import { api, img, type LibraryItem, type Progress } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h, toast } from '../dom.ts';
import { canResume, progressRatio, relativeTime, routeHref } from '../format.ts';
import { LIBRARY_SORTS, parseLibrarySort, sortLibrary, typeCounts, type LibrarySort } from '../lists.ts';
import { formatTime } from '../sync.ts';
import { cardButton, confirmButton, emptyState, icon, posterCard, progressBar, segmented, skeletonGrid, skeletonLines } from '../ui.ts';
import { markProgressWatched } from './home.ts';

type TypeFilter = '' | 'movie' | 'series';
const parseType = (v: string | undefined): TypeFilter => (v === 'movie' || v === 'series' ? v : '');

/** Search box inside a page: Escape clears it. */
function pageSearch(label: string, value: string, onInput: (v: string) => void) {
  const input = h('input', {
    class: 'input inpage-search-input',
    type: 'search',
    placeholder: label,
    'aria-label': label,
    autocomplete: 'off',
    value,
  });
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      onInput('');
    }
  });
  return h('label', { class: 'inpage-search' }, icon('search', 'icon icon-sm'), input);
}

export function libraryView(app: App, params: Record<string, string>): View {
  let type = parseType(params.type);
  let sort: LibrarySort = parseLibrarySort(params.sort);
  let q = params.q || '';
  let items: LibraryItem[] = [];

  const typeHost = h('div', { class: 'filter-slot' });
  const count = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const grid = h('div', { class: 'grid' }, skeletonGrid(8));
  const sortSel = h(
    'select',
    {
      class: 'input',
      'aria-label': 'Trier par',
      onchange: (e: Event) => {
        sort = parseLibrarySort((e.currentTarget as HTMLSelectElement).value);
        update();
      },
    },
    LIBRARY_SORTS.map(([v, label]) => h('option', { value: v }, label))
  );
  sortSel.value = sort;
  const search = pageSearch('Chercher dans ma bibliothèque', q, (v) => {
    q = v;
    update();
  });
  const el = h(
    'div',
    { class: 'page page-library' },
    h('h1', { class: 'page-title' }, 'Bibliothèque'),
    h('div', { class: 'filters' }, typeHost, h('div', { class: 'filter-group' }, h('span', { class: 'filter-label' }, 'Trier par'), sortSel), search),
    count,
    grid
  );

  const update = () => {
    app.replaceRoute(routeHref('library', { type, sort: sort === 'recent' ? '' : sort, q: q.trim() }));
    render();
  };

  const card = (item: LibraryItem) => {
    const c: HTMLElement = posterCard(item, {
      actions: [
        cardButton('close', `Retirer ${item.name} de la bibliothèque`, async () => {
          try {
            await api(`/api/library/${item.type}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            items = items.filter((i) => i.id !== item.id);
            toast(`« ${item.name} » retiré de la bibliothèque`);
            render();
          } catch (err) {
            toast((err as Error).message);
          }
        }),
      ],
    });
    return c;
  };

  function render() {
    const counts = typeCounts(items, q);
    clear(
      typeHost,
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
      )
    );
    if (!items.length) {
      count.textContent = '';
      clear(
        grid,
        emptyState(
          'Ta bibliothèque est vide',
          'Ajoute des titres depuis leur fiche avec « Ajouter à la bibliothèque ».',
          h('a', { class: 'btn btn-primary', href: routeHref('discover') }, 'Découvrir')
        )
      );
      return;
    }
    const shown = sortLibrary(items, { type, sort, q });
    count.textContent = `${shown.length} titre${shown.length > 1 ? 's' : ''}`;
    clear(
      grid,
      shown.length
        ? shown.map(card)
        : emptyState(
            q ? `Rien ne correspond à « ${q.trim()} »` : type === 'movie' ? 'Aucun film dans ta bibliothèque' : 'Aucune série dans ta bibliothèque',
            undefined,
            h(
              'button',
              {
                class: 'btn btn-ghost',
                type: 'button',
                onclick: () => {
                  q = '';
                  type = '';
                  (search.querySelector('input') as HTMLInputElement).value = '';
                  update();
                },
              },
              'Tout afficher'
            )
          )
    );
  }

  const load = () =>
    api<{ items: LibraryItem[] }>('/api/library')
      .then((r) => {
        items = r.items;
        render();
      })
      .catch((err: Error) =>
        clear(grid, emptyState('Bibliothèque indisponible', err.message, h('button', { class: 'btn btn-primary', type: 'button', onclick: load }, 'Réessayer')))
      );
  load();

  return { el };
}

export function historyView(_app: App): View {
  const list = h('div', { class: 'history-list' }, skeletonLines());
  const clearBtn = confirmButton(
    { class: 'btn btn-ghost btn-sm btn-danger', label: 'Effacer l’historique', confirmLabel: 'Tout effacer ? Clique encore', icon: 'trash' },
    async () => {
      await api('/api/history', { method: 'DELETE' });
      toast('Historique effacé');
      showEmpty();
    }
  );
  clearBtn.hidden = true;
  const count = h('span', { class: 'result-count' });
  const el = h(
    'div',
    { class: 'page page-history' },
    h('header', { class: 'page-head' }, h('div', { class: 'page-head-text' }, h('h1', { class: 'page-title' }, 'Historique'), count), clearBtn),
    list
  );

  const showEmpty = () => {
    clearBtn.hidden = true;
    count.textContent = '';
    clear(
      list,
      emptyState(
        "Tu n'as encore rien regardé",
        'Ce que tu regardes apparaîtra ici, avec ta progression.',
        h('a', { class: 'btn btn-primary', href: routeHref('discover') }, 'Découvrir')
      )
    );
  };
  const updateCount = () => {
    const n = list.querySelectorAll('.history-item').length;
    if (!n) return showEmpty();
    count.textContent = `${n} titre${n > 1 ? 's' : ''}`;
  };

  const line = (p: Progress) => {
    const href = routeHref('detail', { type: p.type, id: p.metaId, video: p.type === 'series' ? p.videoId : null });
    const resumable = canResume(p);
    const finished = p.watched && !resumable;
    const progressHost = h('span', { class: 'history-progress' });
    const renderProgress = (done: boolean) =>
      clear(
        progressHost,
        progressBar(done ? 1 : progressRatio(p.position, p.duration)),
        h('span', { class: 'faint small' }, done ? 'Vu' : `${formatTime(p.position)} / ${formatTime(p.duration || 0)}`)
      );
    renderProgress(finished);
    const watchBtn = finished
      ? null
      : cardButton('check', `Marquer ${p.name}${p.episode ? ` (${p.episode.split(' · ')[0]})` : ''} comme vu`, async (b) => {
          try {
            await markProgressWatched(p);
            renderProgress(true);
            b.remove();
            playLabel.textContent = 'Revoir';
            toast('Marqué comme vu');
          } catch (err) {
            toast((err as Error).message);
          }
        });
    watchBtn?.classList.replace('card-btn', 'btn');
    watchBtn?.classList.add('btn-ghost', 'btn-icon');
    const remove = cardButton('trash', `Retirer ${p.name} de l'historique`, async () => {
      try {
        await api(`/api/history/${encodeURIComponent(p.metaId)}`, { method: 'DELETE' });
        item.remove();
        toast(`« ${p.name} » retiré de l’historique`);
        updateCount();
      } catch (err) {
        toast((err as Error).message);
      }
    });
    remove.classList.replace('card-btn', 'btn');
    remove.classList.add('btn-ghost', 'btn-icon');
    const playLabel = h('span', {}, resumable ? 'Reprendre' : finished ? 'Revoir' : 'Regarder');
    const item = h(
      'div',
      { class: 'history-item' },
      h('a', { class: 'history-poster', href, tabindex: -1, 'aria-hidden': 'true' }, p.poster ? h('img', { src: img(p.poster), alt: '', loading: 'lazy', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() }) : null),
      h(
        'div',
        { class: 'history-text' },
        h('a', { class: 'history-title', href }, p.name),
        h('span', { class: 'muted' }, [p.episode, relativeTime(p.updatedAt)].filter(Boolean).join(' · ')),
        progressHost
      ),
      h('div', { class: 'history-actions' }, h('a', { class: 'btn btn-primary btn-sm', href }, icon('play', 'icon icon-sm'), playLabel), watchBtn, remove)
    );
    return item;
  };

  const load = () =>
    api<{ items: Progress[] }>('/api/history')
      .then(({ items }) => {
        if (!items.length) return showEmpty();
        clearBtn.hidden = false;
        clear(list, items.map(line));
        updateCount();
      })
      .catch((err: Error) =>
        clear(list, emptyState('Historique indisponible', err.message, h('button', { class: 'btn btn-primary', type: 'button', onclick: load }, 'Réessayer')))
      );
  load();

  return { el };
}
