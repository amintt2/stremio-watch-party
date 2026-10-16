import { api, img, type Meta, type Progress, type StreamOption, type Video } from '../api.ts';
import type { App, View } from '../app.ts';
import { clear, h, toast } from '../dom.ts';
import { canResume, episodeCode, progressRatio } from '../format.ts';
import { StreamPanel } from '../streams.ts';
import { formatTime } from '../sync.ts';
import { emptyState, icon, loadingState, progressBar } from '../ui.ts';

/** Title page: backdrop, infos, actions, seasons/episodes, and the source panel on the side. */
export function detailView(app: App, params: Record<string, string>): View {
  const el = h('div', { class: 'page page-detail' }, loadingState());
  let disposed = false;

  Promise.all([
    api<{ meta: Meta }>(`/api/meta/${params.type}/${encodeURIComponent(params.id)}`),
    api<{ items: Progress[]; inLibrary: boolean }>(`/api/progress/${encodeURIComponent(params.id)}`).catch(() => ({ items: [], inLibrary: false })),
  ])
    .then(([{ meta }, progress]) => {
      if (!disposed) render(app, el, meta, progress.items, progress.inLibrary, params.video);
    })
    .catch((err: Error) => clear(el, emptyState('Fiche introuvable', err.message)));

  return { el, dispose: () => (disposed = true) };
}

function render(app: App, el: HTMLElement, meta: Meta, progressList: Progress[], inLibrary: boolean, wantedVideo?: string) {
  const progress = new Map(progressList.map((p) => [p.videoId, p]));
  const isSeries = meta.type === 'series' && meta.videos.length > 0;
  const panel = new StreamPanel();

  // ---- which video the actions and the panel are about
  let video: Video | null = null;
  if (isSeries) {
    const latest = progressList[0]?.videoId;
    video =
      meta.videos.find((v) => v.id === wantedVideo) ||
      meta.videos.find((v) => v.id === latest) ||
      meta.videos.find((v) => v.season > 0) ||
      meta.videos[0];
  }
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

  // ---- hero
  const actions = h('div', { class: 'detail-actions' });
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
            else await api(path, { method: 'PUT', body: JSON.stringify({ name: meta.name, poster: meta.poster, year: meta.year }) });
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
  const facts = [
    meta.releaseInfo || meta.year,
    meta.runtime,
    meta.rating ? h('span', { class: 'rating' }, icon('star', 'icon icon-xs'), meta.rating) : null,
    isSeries ? `${new Set(meta.videos.filter((v) => v.season > 0).map((v) => v.season)).size} saison(s)` : null,
  ].filter(Boolean);

  const hero = h(
    'section',
    { class: 'detail-hero' },
    meta.poster ? h('img', { class: 'detail-poster', src: img(meta.poster), alt: '' }) : null,
    h(
      'div',
      { class: 'detail-info' },
      title,
      h('p', { class: 'detail-facts' }, facts.flatMap((f, i) => (i ? [h('span', { class: 'dot' }, '•'), f!] : [f!]))),
      meta.genres.length ? h('div', { class: 'chips' }, meta.genres.map((g) => h('span', { class: 'chip' }, g))) : null,
      meta.description ? h('p', { class: 'description' }, meta.description) : null,
      meta.cast.length ? h('p', { class: 'credits' }, h('span', { class: 'faint' }, 'Avec '), meta.cast.join(', ')) : null,
      meta.director.length ? h('p', { class: 'credits' }, h('span', { class: 'faint' }, 'Réalisation '), meta.director.join(', ')) : null,
      actions
    )
  );

  // ---- seasons / episodes
  let episodesSection: HTMLElement | null = null;
  if (isSeries) {
    const seasons = [...new Set(meta.videos.map((v) => v.season))];
    const list = h('div', { class: 'episode-list' });
    const select = h(
      'select',
      { class: 'input', 'aria-label': 'Saison' },
      seasons.map((s) => h('option', { value: s }, s === 0 ? 'Bonus' : `Saison ${s}`))
    );
    const showSeason = () => {
      const season = Number(select.value);
      clear(list, meta.videos.filter((v) => v.season === season).map((v) => episodeRow(v)));
    };
    const episodeRow = (v: Video) => {
      const p = progress.get(v.id);
      const ratio = p ? progressRatio(p.position, p.duration) : 0;
      return h(
        'button',
        {
          class: `episode${v.id === video?.id ? ' active' : ''}${p?.watched ? ' watched' : ''}`,
          type: 'button',
          onclick: (e: Event) => {
            video = v;
            list.querySelectorAll('.episode').forEach((x) => x.classList.remove('active'));
            (e.currentTarget as HTMLElement).classList.add('active');
            renderActions();
            panel.load('series', v.id, `${episodeCode(v.season, v.episode)} · ${v.title}`);
            if (window.matchMedia('(max-width: 900px)').matches) panel.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        h(
          'span',
          { class: 'episode-thumb' },
          v.thumbnail ? h('img', { src: img(v.thumbnail), alt: '', loading: 'lazy', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() }) : null,
          p && !p.watched && ratio > 0 ? progressBar(ratio, 'progress progress-poster') : null
        ),
        h(
          'span',
          { class: 'episode-text' },
          h('span', { class: 'episode-title' }, `${v.episode}. ${v.title}`),
          h(
            'span',
            { class: 'episode-sub' },
            v.released ? new Date(v.released).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
            p && !p.watched && canResume(p) ? ` · reprendre à ${formatTime(p.position)}` : ''
          ),
          v.overview ? h('span', { class: 'episode-overview' }, v.overview) : null
        ),
        p?.watched ? h('span', { class: 'episode-watched', title: 'Vu' }, icon('check', 'icon icon-sm')) : null
      );
    };
    select.addEventListener('change', showSeason);
    select.value = String(video!.season);
    showSeason();
    episodesSection = h('section', { class: 'episodes' }, h('header', { class: 'episodes-head' }, h('h2', {}, 'Épisodes'), select), list);
    requestAnimationFrame(() => list.querySelector('.episode.active')?.scrollIntoView({ block: 'nearest' }));
  }

  const backdrop = h('div', { class: 'detail-backdrop', 'aria-hidden': 'true' }, meta.background ? h('img', { src: img(meta.background), alt: '' }) : null);
  clear(el, backdrop, h('div', { class: 'detail-layout' }, h('div', { class: 'detail-main' }, hero, episodesSection), panel.el));

  renderActions();
  if (video) panel.load('series', video.id, `${episodeCode(video.season, video.episode)} · ${video.title}`);
  else panel.load('movie', meta.id, 'Sources');
}
