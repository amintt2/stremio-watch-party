import { api, img, type Meta, type SearchResult, type StreamOption } from './api.ts';
import { clear, h, toast } from './dom.ts';

type SortMode = 'addon' | 'seeders' | 'size';
const QUALITY_FILTERS = ['Tous', '4K', '1080p', '720p'];

function sizeInGb(size: string | null) {
  if (!size) return 0;
  const m = /([\d.]+)\s*([KMGT])/i.exec(size);
  if (!m) return 0;
  const factor = { K: 1e-6, M: 1e-3, G: 1, T: 1e3 }[m[2].toUpperCase() as 'K' | 'M' | 'G' | 'T'];
  return Number(m[1]) * factor;
}

/** Search → title → (season/episode) → source picker. Starting a source plays it for the whole room. */
export class Browser {
  readonly el = h('section', { class: 'browse', 'aria-label': 'Choisir un film' });
  onStarted: () => void = () => {};

  private body = h('div', { class: 'browse-body' });
  private input = h('input', {
    class: 'input input-lg',
    type: 'search',
    placeholder: 'Rechercher un film ou une série…',
    'aria-label': 'Recherche',
  });
  private searchSeq = 0;

  constructor() {
    const form = h(
      'form',
      {
        class: 'search-bar',
        onsubmit: (e: Event) => {
          e.preventDefault();
          this.search(this.input.value);
        },
      },
      this.input,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Rechercher')
    );
    this.el.append(form, this.body);
    clear(this.body, h('p', { class: 'empty' }, 'Cherche un titre pour le regarder ensemble.'));
  }

  focus() {
    this.input.focus();
  }

  private loading(text = 'Chargement…') {
    clear(this.body, h('p', { class: 'empty' }, h('span', { class: 'spinner' }), text));
  }

  async search(query: string) {
    if (query.trim().length < 2) return;
    const seq = ++this.searchSeq;
    this.loading('Recherche…');
    try {
      const { results } = await api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`);
      if (seq !== this.searchSeq) return;
      if (!results.length) {
        clear(this.body, h('p', { class: 'empty' }, 'Aucun résultat.'));
        return;
      }
      clear(
        this.body,
        h(
          'div',
          { class: 'grid' },
          results.map((r) =>
            h(
              'button',
              { class: 'card', type: 'button', onclick: () => this.open(r.type, r.id) },
              r.poster ? h('img', { src: img(r.poster), alt: '', loading: 'lazy' }) : h('div', { class: 'card-ph' }, r.name),
              h('span', { class: 'card-title' }, r.name),
              h('span', { class: 'card-sub' }, [r.year, r.type === 'series' ? 'Série' : 'Film'].filter(Boolean).join(' · '))
            )
          )
        )
      );
    } catch (err) {
      clear(this.body, h('p', { class: 'auth-error' }, (err as Error).message));
    }
  }

  private async open(type: string, id: string) {
    this.loading();
    let meta: Meta;
    try {
      ({ meta } = await api<{ meta: Meta }>(`/api/meta/${type}/${encodeURIComponent(id)}`));
    } catch (err) {
      clear(this.body, h('p', { class: 'auth-error' }, (err as Error).message));
      return;
    }
    const sources = h('div', { class: 'sources' });
    const header = h(
      'div',
      { class: 'detail' },
      meta.poster ? h('img', { class: 'detail-poster', src: img(meta.poster), alt: '' }) : null,
      h(
        'div',
        { class: 'detail-info' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => this.search(this.input.value) }, '← Résultats'),
        h('h2', {}, meta.name),
        h('p', { class: 'muted' }, [meta.year, meta.runtime].filter(Boolean).join(' · ')),
        h('p', { class: 'description' }, meta.description)
      )
    );

    if (meta.type === 'series' && meta.videos.length) {
      const seasons = [...new Set(meta.videos.map((v) => v.season))];
      const episodes = h('div', { class: 'episodes' });
      const select = h(
        'select',
        { class: 'input', 'aria-label': 'Saison' },
        seasons.map((s) => h('option', { value: s }, s === 0 ? 'Bonus' : `Saison ${s}`))
      );
      const showSeason = () => {
        const season = Number(select.value);
        clear(
          episodes,
          meta.videos
            .filter((v) => v.season === season)
            .map((v) =>
              h(
                'button',
                {
                  class: 'episode',
                  type: 'button',
                  onclick: (e: Event) => {
                    episodes.querySelectorAll('.episode').forEach((el) => el.classList.remove('active'));
                    (e.currentTarget as HTMLElement).classList.add('active');
                    this.loadStreams(sources, 'series', v.id, meta, `S${v.season}E${String(v.episode).padStart(2, '0')} · ${v.title}`);
                  },
                },
                h('span', { class: 'ep-num' }, String(v.episode)),
                h('span', {}, v.title)
              )
            )
        );
      };
      select.addEventListener('change', showSeason);
      select.value = String(seasons.find((s) => s > 0) ?? seasons[0]);
      showSeason();
      clear(this.body, header, h('div', { class: 'series-pick' }, select, episodes), sources);
    } else {
      clear(this.body, header, sources);
      this.loadStreams(sources, 'movie', meta.id, meta, '');
    }
  }

  private async loadStreams(host: HTMLElement, type: string, id: string, meta: Meta, subtitle: string) {
    clear(host, h('p', { class: 'empty' }, h('span', { class: 'spinner' }), 'Recherche des sources…'));
    let list: StreamOption[];
    let failed = 0;
    try {
      const res = await api<{ streams: StreamOption[]; failedAddons: number }>(`/api/streams/${type}/${encodeURIComponent(id)}`);
      list = res.streams;
      failed = res.failedAddons;
    } catch (err) {
      clear(host, h('p', { class: 'auth-error' }, (err as Error).message));
      return;
    }
    if (!list.length) {
      clear(host, h('p', { class: 'empty' }, failed ? 'Les addons de sources ne répondent pas.' : 'Aucune source trouvée.'));
      return;
    }

    let sort: SortMode = 'addon';
    let filter = 'Tous';
    const rows = h('div', { class: 'source-list' });

    const render = () => {
      const visible = list.filter((s) => filter === 'Tous' || s.quality === filter);
      if (sort === 'seeders') visible.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
      if (sort === 'size') visible.sort((a, b) => sizeInGb(b.size) - sizeInGb(a.size));
      clear(
        rows,
        visible.length ? visible.map((s) => this.sourceRow(s, meta, subtitle)) : h('p', { class: 'empty' }, 'Aucune source dans cette qualité.')
      );
    };

    const filters = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Qualité' },
      QUALITY_FILTERS.map((q) =>
        h(
          'button',
          {
            type: 'button',
            class: q === filter ? 'active' : '',
            onclick: (e: Event) => {
              filter = q;
              filters.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
              (e.currentTarget as HTMLElement).classList.add('active');
              render();
            },
          },
          q
        )
      )
    );
    const sortSelect = h(
      'select',
      {
        class: 'input',
        'aria-label': 'Trier',
        onchange: (e: Event) => {
          sort = (e.currentTarget as HTMLSelectElement).value as SortMode;
          render();
        },
      },
      h('option', { value: 'addon' }, "Ordre de l'addon"),
      h('option', { value: 'seeders' }, 'Plus de sources'),
      h('option', { value: 'size' }, 'Plus gros fichier')
    );

    clear(
      host,
      h('div', { class: 'sources-toolbar' }, h('h3', {}, subtitle || 'Sources'), filters, sortSelect),
      failed ? h('p', { class: 'muted' }, `${failed} addon(s) n'ont pas répondu.`) : null,
      rows
    );
    render();
  }

  private sourceRow(s: StreamOption, meta: Meta, subtitle: string) {
    const badges = [
      s.quality && h('span', { class: 'badge badge-strong' }, s.quality),
      s.hdr && h('span', { class: 'badge' }, s.dolbyVision ? 'DV' : 'HDR'),
      s.hevc && h('span', { class: 'badge' }, 'HEVC'),
      s.cached && h('span', { class: 'badge badge-success' }, '⚡ Débrid'),
    ];
    const facts = [
      s.seeders !== null && h('span', { title: 'Personnes qui partagent' }, `👤 ${s.seeders}`),
      s.size && h('span', {}, `💾 ${s.size}`),
      s.origin && h('span', {}, s.origin),
      h('span', { class: 'faint' }, s.label),
    ];
    return h(
      'button',
      {
        class: 'source',
        type: 'button',
        title: s.release,
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          btn.classList.add('busy');
          try {
            await api('/api/room/play', {
              method: 'POST',
              body: JSON.stringify({ streamKey: s.key, title: meta.name, subtitle, poster: meta.poster }),
            });
            this.onStarted();
          } catch (err) {
            toast((err as Error).message);
          } finally {
            btn.disabled = false;
            btn.classList.remove('busy');
          }
        },
      },
      h('span', { class: 'source-badges' }, badges),
      h('span', { class: 'source-release' }, s.release),
      h('span', { class: 'source-facts' }, facts)
    );
  }
}
