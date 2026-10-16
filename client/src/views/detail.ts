import { api, img, type Meta, type Progress, type StreamOption, type Video } from '../api.ts';
import type { App, View } from '../app.ts';
import { openExternal, publicBase } from '../auth.ts';
import { clear, h, toast } from '../dom.ts';
import { canResume, episodeCode, progressRatio, routeHref } from '../format.ts';
import { defaultEpisode, isUpcoming, nextEpisode } from '../lists.ts';
import { StreamPanel } from '../streams.ts';
import { formatTime } from '../sync.ts';
import { copyText, emptyState, icon, posterCard, progressBar, row, skeletonDetail } from '../ui.ts';

const dateFr = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const STATUS: Record<string, string> = { Continuing: 'En cours', Ended: 'Terminée', 'Returning Series': 'En cours', Canceled: 'Annulée' };

/** Title page: backdrop, infos, actions, seasons/episodes, and the source panel on the side. */
export function detailView(app: App, params: Record<string, string>): View {
  const el = h('div', { class: 'page page-detail' }, skeletonDetail());
  let disposed = false;

  const load = () =>
    Promise.all([
      api<{ meta: Meta }>(`/api/meta/${params.type}/${encodeURIComponent(params.id)}`),
      api<{ items: Progress[]; inLibrary: boolean }>(`/api/progress/${encodeURIComponent(params.id)}`).catch(() => ({ items: [], inLibrary: false })),
    ])
      .then(([{ meta }, progress]) => {
        if (!disposed) render(app, el, meta, progress.items, progress.inLibrary, params.video);
      })
      .catch((err: Error) => {
        if (disposed) return;
        clear(
          el,
          emptyState(
            'Fiche introuvable',
            err.message,
            h(
              'div',
              { class: 'empty-actions' },
              h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (clear(el, skeletonDetail()), load()) }, 'Réessayer'),
              h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (history.length > 1 ? history.back() : app.navigate(routeHref('home'))) }, 'Retour')
            )
          )
        );
      });
  load();

  return { el, dispose: () => (disposed = true) };
}

function render(app: App, el: HTMLElement, meta: Meta, progressList: Progress[], inLibrary: boolean, wantedVideo?: string) {
  let progress = new Map(progressList.map((p) => [p.videoId, p]));
  const isSeries = meta.type === 'series' && meta.videos.length > 0;
  const panel = new StreamPanel();

  // ---- which video the actions and the panel are about
  let video: Video | null = isSeries ? defaultEpisode(meta.videos, progressList, wantedVideo) : null;
  const videoId = () => video?.id || meta.id;
  const subtitle = () => (video ? `${episodeCode(video.season, video.episode)} · ${video.title}` : '');
  const resumeAt = () => {
    const p = progress.get(videoId());
    return canResume(p) ? p!.position : 0;
  };
  let useResume = true;

  const start = async (pick: () => Promise<StreamOption | null>, startAt: number, button: HTMLButtonElement) => {
    button.disabled = true;
    button.classList.add('busy');
    try {
      const s = await pick();
      if (!s) {
        toast('Aucune source disponible pour ce titre.');
        return;
      }
      await app.play({
        streamKey: s.key,
        meta: { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster },
        videoId: videoId(),
        subtitle: subtitle(),
        startAt,
      });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      button.disabled = false;
      button.classList.remove('busy');
    }
  };
  panel.onPick = (s, button) => start(async () => s, useResume ? resumeAt() : 0, button);

  // ---- watched marks (movie, episode, season)
  const setWatched = async (videos: Video[] | null, watched: boolean) => {
    const list = videos ? videos.map((v) => ({ videoId: v.id, episode: `${episodeCode(v.season, v.episode)} · ${v.title}` })) : [{ videoId: meta.id, episode: null }];
    if (!list.length) return;
    const res = await api<{ items: Progress[] }>('/api/watched', {
      method: 'POST',
      body: JSON.stringify({ metaId: meta.id, type: meta.type, name: meta.name, poster: meta.poster, watched, videos: list }),
    });
    progress = new Map(res.items.map((p) => [p.videoId, p]));
    renderActions();
    renderEpisodes?.();
  };
  const isWatched = (id: string) => !!progress.get(id)?.watched;

  // ---- hero
  const actions = h('div', { class: 'detail-actions' });
  const more = h('div', { class: 'detail-more' });
  const episodeLine = h('div', { class: 'detail-episode' });

  const selectVideo = (v: Video, scroll: boolean) => {
    video = v;
    renderActions();
    renderEpisodes?.(true);
    panel.load('series', v.id, subtitle());
    if (scroll && window.matchMedia('(max-width: 1100px)').matches) panel.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const renderActions = () => {
    const at = resumeAt();
    const watchBtn: HTMLButtonElement = h(
      'button',
      {
        class: `btn ${at ? 'btn-secondary' : 'btn-primary'} btn-lg`,
        type: 'button',
        title: 'Lance la meilleure source pour tout le salon',
        onclick: () => start(() => panel.best(), 0, watchBtn),
      },
      icon('users'),
      at ? 'Depuis le début' : 'Regarder ensemble'
    );
    const resumeBtn: HTMLButtonElement | null = at
      ? h(
          'button',
          { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => start(() => panel.best(), at, resumeBtn!) },
          icon('play'),
          `Reprendre à ${formatTime(at)}`
        )
      : null;
    const libBtn: HTMLButtonElement = h(
      'button',
      {
        class: `btn btn-ghost btn-lg${inLibrary ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': inLibrary ? 'true' : 'false',
        onclick: async () => {
          libBtn.disabled = true;
          try {
            const path = `/api/library/${meta.type}/${encodeURIComponent(meta.id)}`;
            if (inLibrary) await api(path, { method: 'DELETE' });
            else await api(path, { method: 'PUT', body: JSON.stringify({ name: meta.name, poster: meta.poster, year: meta.year, rating: meta.rating }) });
            inLibrary = !inLibrary;
            toast(inLibrary ? 'Ajouté à la bibliothèque' : 'Retiré de la bibliothèque');
            renderActions();
          } catch (err) {
            toast((err as Error).message);
            libBtn.disabled = false;
          }
        },
      },
      icon(inLibrary ? 'check' : 'plus'),
      inLibrary ? 'Dans la bibliothèque' : 'Ajouter à la bibliothèque'
    );
    clear(actions, resumeBtn, watchBtn, libBtn);

    // Secondary actions: seen, trailer, IMDb, share.
    const small = (iconName: string, label: string, onclick: (b: HTMLButtonElement) => void | Promise<void>, attrs: Record<string, string> = {}) => {
      const b: HTMLButtonElement = h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          ...attrs,
          onclick: async () => {
            b.disabled = true;
            try {
              await onclick(b);
            } catch (err) {
              toast((err as Error).message);
            } finally {
              b.disabled = false;
            }
          },
        },
        icon(iconName, 'icon icon-sm'),
        label
      );
      return b;
    };
    const seen = isWatched(videoId());
    const seenBtn = isSeries
      ? null
      : small(seen ? 'eye-off' : 'check', seen ? 'Marquer comme non vu' : 'Marquer comme vu', async () => {
          await setWatched(null, !seen);
          toast(seen ? 'Marqué comme non vu' : 'Marqué comme vu');
        }, { 'aria-pressed': seen ? 'true' : 'false' });
    const trailerBtn = meta.trailer ? small('trailer', 'Bande-annonce', () => openExternal(`https://www.youtube.com/watch?v=${encodeURIComponent(meta.trailer!)}`), { title: 'Ouvre YouTube' }) : null;
    const imdbBtn = meta.imdbId
      ? small('external', meta.rating ? `IMDb ${meta.rating}` : 'IMDb', () => openExternal(`https://www.imdb.com/title/${encodeURIComponent(meta.imdbId!)}/`), { title: 'Ouvre la fiche IMDb' })
      : null;
    const shareBtn = small('share', 'Partager', () => copyText(`${publicBase()}/${routeHref('detail', { type: meta.type, id: meta.id })}`, 'Lien de la fiche copié'));
    clear(more, seenBtn, trailerBtn, imdbBtn, shareBtn);

    // Series: the selected episode, with a shortcut to the next one.
    if (isSeries && video) {
      const next = nextEpisode(meta.videos, video);
      const p = progress.get(video.id);
      clear(
        episodeLine,
        h(
          'div',
          { class: 'detail-episode-text' },
          h('span', { class: 'faint small' }, isWatched(video.id) ? 'Épisode sélectionné · vu' : p && canResume(p) ? 'Épisode en cours' : 'Épisode sélectionné'),
          h('strong', {}, subtitle())
        ),
        h(
          'div',
          { class: 'detail-episode-actions' },
          small(isWatched(video.id) ? 'eye-off' : 'check', isWatched(video.id) ? 'Non vu' : 'Vu', () => setWatched([video!], !isWatched(video!.id)), {
            title: isWatched(video.id) ? 'Marquer cet épisode comme non vu' : 'Marquer cet épisode comme vu',
          }),
          next
            ? small('next', 'Épisode suivant', () => selectVideo(next, false), {
                title: `${episodeCode(next.season, next.episode)} · ${next.title}${isUpcoming(next) && next.released ? ` (sort le ${dateFr(next.released)})` : ''}`,
              })
            : null
        )
      );
    }

    // Same choice for a source picked by hand.
    useResume = !!at;
    panel.setExtra(
      at
        ? h(
            'div',
            { class: 'segmented segmented-wide', role: 'group', 'aria-label': 'Départ' },
            [
              [true, `Reprendre à ${formatTime(at)}`],
              [false, 'Depuis le début'],
            ].map(([value, text]) =>
              h(
                'button',
                {
                  type: 'button',
                  class: value === useResume ? 'active' : '',
                  onclick: (e: Event) => {
                    useResume = value as boolean;
                    (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
                    (e.currentTarget as HTMLElement).classList.add('active');
                  },
                },
                text as string
              )
            )
          )
        : null
    );
  };

  const title = meta.logo
    ? h('img', {
        class: 'detail-logo',
        src: img(meta.logo),
        alt: meta.name,
        onerror: (e: Event) => (e.currentTarget as HTMLElement).replaceWith(h('h1', { class: 'detail-title' }, meta.name)),
      })
    : h('h1', { class: 'detail-title' }, meta.name);
  const seasonCount = isSeries ? new Set(meta.videos.filter((v) => v.season > 0).map((v) => v.season)).size : 0;
  const facts = [
    meta.releaseInfo || meta.year,
    meta.runtime,
    meta.rating ? h('span', { class: 'rating', title: 'Note IMDb' }, icon('star', 'icon icon-xs'), meta.rating) : null,
    isSeries ? `${seasonCount} saison${seasonCount > 1 ? 's' : ''}` : null,
    meta.status && STATUS[meta.status] ? STATUS[meta.status] : null,
  ].filter(Boolean);

  const personLinks = (names: string[]) =>
    names.flatMap((n, i) => [i ? ', ' : null, h('a', { class: 'credit-link', href: routeHref('search', { q: n }), title: `Chercher « ${n} »` }, n)]);

  const hero = h(
    'section',
    { class: 'detail-hero' },
    meta.poster ? h('img', { class: 'detail-poster', src: img(meta.poster), alt: '', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() }) : null,
    h(
      'div',
      { class: 'detail-info' },
      title,
      h('p', { class: 'detail-facts' }, facts.flatMap((f, i) => (i ? [h('span', { class: 'dot' }, '•'), f!] : [f!]))),
      meta.genres.length
        ? h(
            'div',
            { class: 'chips' },
            meta.genres.map((g) => h('a', { class: 'chip chip-link', href: routeHref('discover', { type: meta.type, genre: g }), title: `Découvrir : ${g}` }, g))
          )
        : null,
      meta.description ? h('p', { class: 'description' }, meta.description) : null,
      meta.cast.length ? h('p', { class: 'credits' }, h('span', { class: 'faint' }, 'Avec '), personLinks(meta.cast.slice(0, 6))) : null,
      meta.director.length ? h('p', { class: 'credits' }, h('span', { class: 'faint' }, 'Réalisation '), personLinks(meta.director)) : null,
      !meta.director.length && meta.writers?.length ? h('p', { class: 'credits' }, h('span', { class: 'faint' }, 'Création '), personLinks(meta.writers)) : null,
      meta.awards ? h('p', { class: 'credits faint small' }, meta.awards) : null,
      actions,
      more,
      isSeries ? episodeLine : null
    )
  );

  // ---- seasons / episodes
  let episodesSection: HTMLElement | null = null;
  let renderEpisodes: ((sync?: boolean) => void) | null = null;
  if (isSeries) {
    const seasons = [...new Set(meta.videos.map((v) => v.season))];
    const list = h('div', { class: 'episode-list' });
    const select = h(
      'select',
      { class: 'input', 'aria-label': 'Saison' },
      seasons.map((s) => h('option', { value: s }, s === 0 ? 'Bonus' : `Saison ${s}`))
    );
    const seasonBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' });
    const seasonVideos = () => meta.videos.filter((v) => v.season === Number(select.value));

    const episodeRow = (v: Video) => {
      const p = progress.get(v.id);
      const ratio = p ? progressRatio(p.position, p.duration) : 0;
      const upcoming = isUpcoming(v);
      const watched = !!p?.watched;
      return h(
        'div',
        { class: `episode${v.id === video?.id ? ' active' : ''}${watched ? ' watched' : ''}${upcoming ? ' upcoming' : ''}` },
        h(
          'button',
          {
            class: 'episode-main',
            type: 'button',
            'aria-current': v.id === video?.id ? 'true' : null,
            onclick: () => selectVideo(v, true),
          },
          h(
            'span',
            { class: 'episode-thumb' },
            v.thumbnail ? h('img', { src: img(v.thumbnail), alt: '', loading: 'lazy', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() }) : null,
            p && !watched && ratio > 0 ? progressBar(ratio, 'progress progress-poster') : null
          ),
          h(
            'span',
            { class: 'episode-text' },
            h('span', { class: 'episode-title' }, `${v.episode}. ${v.title}`),
            h(
              'span',
              { class: 'episode-sub' },
              upcoming ? h('span', { class: 'badge' }, 'À venir') : null,
              upcoming ? ' ' : null,
              v.released ? (upcoming ? `le ${dateFr(v.released)}` : dateFr(v.released)) : '',
              p && !watched && canResume(p) ? ` · reprendre à ${formatTime(p.position)}` : ''
            ),
            v.overview ? h('span', { class: 'episode-overview' }, v.overview) : null
          )
        ),
        h(
          'button',
          {
            class: `episode-toggle${watched ? ' on' : ''}`,
            type: 'button',
            title: watched ? 'Vu · cliquer pour marquer comme non vu' : 'Marquer comme vu',
            'aria-label': `${episodeCode(v.season, v.episode)} : ${watched ? 'marquer comme non vu' : 'marquer comme vu'}`,
            'aria-pressed': watched ? 'true' : 'false',
            onclick: async (e: Event) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.disabled = true;
              try {
                await setWatched([v], !watched);
              } catch (err) {
                toast((err as Error).message);
                b.disabled = false;
              }
            },
          },
          icon('check', 'icon icon-sm')
        )
      );
    };

    /** sync: show the season of the selected episode (it may have changed with "Épisode suivant"). */
    renderEpisodes = (sync = false) => {
      if (sync && video) select.value = String(video.season);
      const eps = seasonVideos();
      clear(list, eps.map(episodeRow));
      const released = eps.filter((v) => !isUpcoming(v));
      const allSeen = released.length > 0 && released.every((v) => isWatched(v.id));
      clear(seasonBtn, icon(allSeen ? 'eye-off' : 'check', 'icon icon-sm'), allSeen ? 'Saison non vue' : 'Saison vue');
      seasonBtn.title = allSeen ? 'Marquer toute la saison comme non vue' : 'Marquer les épisodes sortis de la saison comme vus';
      seasonBtn.hidden = !released.length;
      seasonBtn.onclick = async () => {
        seasonBtn.disabled = true;
        try {
          await setWatched(released, !allSeen);
          toast(allSeen ? 'Saison marquée comme non vue' : 'Saison marquée comme vue');
        } catch (err) {
          toast((err as Error).message);
        } finally {
          seasonBtn.disabled = false;
        }
      };
    };
    select.addEventListener('change', () => renderEpisodes!());
    episodesSection = h(
      'section',
      { class: 'episodes' },
      h('header', { class: 'episodes-head' }, h('h2', {}, 'Épisodes'), h('div', { class: 'episodes-tools' }, seasonBtn, select)),
      list
    );
  }

  const similar = meta.similar?.length
    ? row(
        'Titres similaires',
        meta.similar.map((s) => posterCard({ id: s.id, type: s.type, name: s.name, poster: null, year: null }, { sub: s.type === 'series' ? 'Série' : 'Film' }))
      )
    : null;

  const backdrop = h(
    'div',
    { class: 'detail-backdrop', 'aria-hidden': 'true' },
    meta.background ? h('img', { src: img(meta.background), alt: '', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() }) : null
  );
  clear(el, backdrop, h('div', { class: 'detail-layout' }, h('div', { class: 'detail-main' }, hero, episodesSection, similar), panel.el));

  renderActions();
  renderEpisodes?.(true);
  if (video) panel.load('series', video.id, subtitle());
  else panel.load('movie', meta.id, 'Sources');
}
