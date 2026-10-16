import './style.css';
import { api, img, type RoomState } from './api.ts';
import type { App, PlayRequest, View } from './app.ts';
import { LoginRequired, loginScreen, signIn, type Identity } from './auth.ts';
import { Connection } from './connection.ts';
import { clear, h, toast } from './dom.ts';
import { parseRoute, routeHref, type Route } from './format.ts';
import { Player } from './player.ts';
import { ExternalSubtitles } from './subtitles.ts';
import { formatTime } from './sync.ts';
import { avatar, icon } from './ui.ts';
import { detailView } from './views/detail.ts';
import { discoverView } from './views/discover.ts';
import { homeView } from './views/home.ts';
import { historyView, libraryView } from './views/library.ts';
import { searchView } from './views/search.ts';
import { applyTheme, savedTheme, settingsView } from './views/settings.ts';

const root = document.getElementById('app')!;
applyTheme(savedTheme());

/** How often each viewer saves their own position (also on pause, stop, leave). */
const PROGRESS_EVERY_MS = 15_000;

async function boot() {
  clear(root, h('div', { class: 'splash' }, h('span', { class: 'spinner' }), 'Connexion…'));
  try {
    start(await signIn());
  } catch (err) {
    if (err instanceof LoginRequired) {
      clear(root, loginScreen(err.config, start));
      return;
    }
    clear(root, h('div', { class: 'splash' }, h('p', { class: 'auth-error' }, (err as Error).message)));
  }
}

const NAV: { name: Route['name']; label: string; icon: string }[] = [
  { name: 'home', label: 'Accueil', icon: 'home' },
  { name: 'discover', label: 'Découvrir', icon: 'discover' },
  { name: 'library', label: 'Bibliothèque', icon: 'library' },
  { name: 'history', label: 'Historique', icon: 'history' },
  { name: 'settings', label: 'Paramètres', icon: 'settings' },
];

function start({ user: me, mode, room }: Identity) {
  const conn = new Connection();
  const video = h('video', { class: 'video', playsinline: true, preload: 'auto' });
  const player = new Player(video, conn);
  let state: RoomState | null = null;
  let route: Route = parseRoute(location.hash);
  let view: View | null = null;
  let viewRoute = '';
  let scrubbing = false;
  /** Whether #/player was pushed on top of an app page (so "back" can pop it). */
  let playerPushed = false;

  // ------------------------------------------------------------ shell
  const navLinks = NAV.map((n) =>
    h('a', { class: 'nav-item', href: routeHref(n.name), 'data-route': n.name }, icon(n.icon), h('span', { class: 'nav-label' }, n.label))
  );
  const rail = h(
    'nav',
    { class: 'rail', 'aria-label': 'Navigation' },
    h('a', { class: 'brand', href: '#/', title: 'Watch Party' }, h('span', { class: 'brand-mark' }, 'W')),
    h('div', { class: 'nav-items' }, navLinks)
  );

  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Rechercher un film, une série…',
    'aria-label': 'Recherche',
    autocomplete: 'off',
  });
  let searchTimer = 0;
  const goSearch = (replace: boolean) => navigate(routeHref('search', { q: searchInput.value.trim() }), replace);
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (searchInput.value.trim().length < 2) return;
    searchTimer = window.setTimeout(() => goSearch(route.name === 'search'), 400);
  });
  const searchForm = h(
    'form',
    {
      class: 'search',
      role: 'search',
      onsubmit: (e: Event) => {
        e.preventDefault();
        clearTimeout(searchTimer);
        goSearch(route.name === 'search');
        searchInput.blur();
      },
    },
    icon('search'),
    searchInput
  );
  const status = h('span', { class: 'conn-dot', title: 'Synchro' });
  const topMembers = h('div', { class: 'members', 'aria-label': 'Dans la salle' });
  const roomBadge =
    mode === 'discord'
      ? null
      : h('a', { class: 'room-badge', href: routeHref('settings'), title: 'Salle : inviter ou rejoindre' }, icon('users', 'icon icon-sm'), room?.code || '');
  const me_ = h('a', { class: 'me', href: routeHref('settings'), title: me.name }, avatar(me));
  const topbar = h('header', { class: 'topbar' }, searchForm, h('div', { class: 'topbar-right' }, roomBadge, topMembers, status, me_));
  const content = h('main', { class: 'content', tabindex: -1 });

  // ------------------------------------------------------------ player stage
  const backBtn = h('button', { class: 'btn btn-ghost btn-icon on-media', type: 'button', 'aria-label': 'Retour' }, icon('back'));
  const stageTitle = h('div', { class: 'stage-title' });
  const stageMembers = h('div', { class: 'members', 'aria-label': 'Spectateurs' });
  const stageTop = h('div', { class: 'stage-top' }, backBtn, stageTitle, stageMembers);

  const playBtn = h('button', { class: 'btn-round', type: 'button', 'aria-label': 'Lecture / pause' }, icon('play'));
  const seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Position' });
  const timeCur = h('span', { class: 'time' }, '0:00');
  const timeDur = h('span', { class: 'time' }, '0:00');
  const qualitySel = h('select', { class: 'input input-sm on-media-input', 'aria-label': 'Qualité' });
  const audioSel = h('select', { class: 'input input-sm on-media-input', 'aria-label': 'Audio' });
  const subsSel = h('select', { class: 'input input-sm on-media-input', 'aria-label': 'Sous-titres' });
  // Subtitles from OpenSubtitles (each viewer their own language), drawn over the video.
  const subsLayer = h('div', { class: 'subs' });
  const subs = new ExternalSubtitles(subsLayer);
  const shiftLabel = h('span', { class: 'subs-shift-value', title: 'Décalage des sous-titres' }, '0 s');
  const subsShift = h(
    'span',
    { class: 'subs-shift', role: 'group', 'aria-label': 'Décalage des sous-titres' },
    h('button', { class: 'btn btn-ghost btn-sm on-media', type: 'button', title: 'Sous-titres plus tôt', onclick: () => subs.shift(-0.5) }, '−'),
    shiftLabel,
    h('button', { class: 'btn btn-ghost btn-sm on-media', type: 'button', title: 'Sous-titres plus tard', onclick: () => subs.shift(0.5) }, '+')
  );
  const volume = h('input', { class: 'volume', type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  const stopBtn = h('button', { class: 'btn btn-ghost btn-sm on-media', type: 'button', title: 'Arrêter pour tout le monde' }, icon('stop', 'icon icon-sm'), h('span', { class: 'btn-label' }, 'Arrêter'));
  const fsBtn = h('button', { class: 'btn btn-ghost btn-icon on-media', type: 'button', 'aria-label': 'Plein écran' }, icon('fullscreen'));
  const controls = h(
    'div',
    { class: 'controls' },
    h('div', { class: 'seek-row' }, timeCur, seek, timeDur),
    h(
      'div',
      { class: 'controls-row' },
      playBtn,
      h('span', { class: 'volume-group' }, icon('volume', 'icon icon-sm'), volume),
      h('div', { class: 'controls-right' }, qualitySel, audioSel, subsSel, subsShift, stopBtn, fsBtn)
    )
  );
  const overlay = h('div', { class: 'overlay' });

  // Mini-player chrome (when browsing while something plays).
  const miniPlay = h('button', { class: 'btn btn-ghost btn-icon on-media', type: 'button', 'aria-label': 'Lecture / pause' }, icon('play'));
  const miniTitle = h('span', { class: 'mini-title' });
  const miniBar = h(
    'div',
    { class: 'mini-bar' },
    miniTitle,
    miniPlay,
    h('button', { class: 'btn btn-ghost btn-icon on-media', type: 'button', 'aria-label': 'Agrandir', onclick: () => openPlayer() }, icon('expand'))
  );
  const stage = h('section', { class: 'stage mode-hidden', 'aria-label': 'Lecteur' }, video, subsLayer, overlay, stageTop, controls, miniBar);

  clear(root, rail, topbar, content, stage, h('div', { id: 'toasts', class: 'toasts' }));

  // ------------------------------------------------------------ app api for views
  const app: App = {
    me,
    mode,
    room,
    player,
    state: () => state,
    navigate,
    async play(req: PlayRequest) {
      await api('/api/room/play', {
        method: 'POST',
        body: JSON.stringify({
          streamKey: req.streamKey,
          title: req.meta.name,
          subtitle: req.subtitle,
          poster: req.meta.poster,
          startAt: req.startAt || 0,
          meta: { id: req.meta.id, type: req.meta.type, videoId: req.videoId },
        }),
      });
      openPlayer();
    },
  };

  // ------------------------------------------------------------ routing
  function navigate(href: string, replace = false) {
    if (replace) {
      history.replaceState(null, '', href);
      render();
    } else if (location.hash !== href) {
      location.hash = href;
    } else render();
  }

  function openPlayer() {
    if (route.name === 'player') return;
    playerPushed = true;
    navigate(routeHref('player'));
  }

  function closePlayer() {
    if (playerPushed) {
      playerPushed = false;
      history.back();
    } else navigate(routeHref('home'), true);
  }

  function render() {
    const leavingPlayer = route.name === 'player';
    route = parseRoute(location.hash);
    // Coming back from the player: progress/history shown underneath may be stale.
    if (leavingPlayer && route.name !== 'player' && !['discover', 'search'].includes(route.name)) viewRoute = '';
    if (route.name === 'player' && !state?.media) {
      // Nothing playing (yet): show home behind the loading state.
      if (state) return navigate(routeHref('home'), true);
    }
    const key = location.hash || '#/';
    if (route.name !== 'player' && key !== viewRoute) {
      view?.dispose?.();
      const r = route;
      view = (() => {
        switch (r.name) {
          case 'discover':
            return discoverView(app, r.params);
          case 'library':
            return libraryView(app, r.params);
          case 'history':
            return historyView(app);
          case 'settings':
            return settingsView(app);
          case 'search':
            return searchView(app, r.params);
          case 'detail':
            return detailView(app, r.params);
          default:
            return homeView(app);
        }
      })();
      viewRoute = key;
      clear(content, view.el);
      content.scrollTop = 0;
    } else if (!view) {
      view = homeView(app);
      viewRoute = '#/';
      clear(content, view.el);
    }
    if (route.name !== 'search' && document.activeElement !== searchInput) searchInput.value = '';
    else if (route.name === 'search' && document.activeElement !== searchInput) searchInput.value = route.params.q || '';
    const active = route.name === 'detail' || route.name === 'search' || route.name === 'player' ? '' : route.name;
    for (const a of navLinks) a.classList.toggle('active', a.dataset.route === active);
    updateStageMode();
  }

  function updateStageMode() {
    const mode = route.name === 'player' ? 'full' : state?.media ? 'mini' : 'hidden';
    stage.className = `stage mode-${mode}${state?.media ? ' has-media' : ''}`;
    document.body.classList.toggle('player-open', mode === 'full');
    if (mode === 'full') wake();
  }

  window.addEventListener('hashchange', () => {
    if (parseRoute(location.hash).name !== 'player') playerPushed = false;
    render();
  });

  // ------------------------------------------------------------ player behaviour
  backBtn.addEventListener('click', closePlayer);
  const togglePlay = () => {
    if (!state?.media) return;
    conn.send({ t: state.paused ? 'play' : 'pause' });
  };
  playBtn.addEventListener('click', togglePlay);
  miniPlay.addEventListener('click', togglePlay);
  seek.addEventListener('input', () => (scrubbing = true));
  seek.addEventListener('change', () => {
    scrubbing = false;
    const d = state?.media?.duration;
    if (d) conn.send({ t: 'seek', position: (Number(seek.value) / 1000) * d });
  });
  qualitySel.addEventListener('change', () => player.setPreference(qualitySel.value));
  audioSel.addEventListener('change', () => player.setAudioTrack(Number(audioSel.value)));
  // "off", "f:<file track>" or "x:<OpenSubtitles key>": one subtitle at a time.
  subsSel.addEventListener('change', () => {
    const [kind, id] = subsSel.value.split(/:(.*)/s);
    if (kind !== 'f' && player.subtitleTrack >= 0) player.setSubtitleTrack(-1);
    if (kind === 'f') {
      if (subs.selected) subs.select(null);
      player.setSubtitleTrack(Number(id));
    } else subs.select(kind === 'x' ? id : null);
  });
  volume.addEventListener('input', () => (video.volume = Number(volume.value)));
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen?.().catch(() => toast('Plein écran indisponible ici'));
  });
  // Two-step confirm: the Discord iframe doesn't allow confirm() dialogs.
  let stopArmed = 0;
  const stopLabel = stopBtn.querySelector('.btn-label')!;
  stopBtn.addEventListener('click', () => {
    if (Date.now() - stopArmed < 3000) {
      stopArmed = 0;
      stopLabel.textContent = 'Arrêter';
      reportProgress();
      api('/api/room/stop', { method: 'POST' }).catch((err) => toast(err.message));
      return;
    }
    stopArmed = Date.now();
    stopLabel.textContent = 'Confirmer ?';
    setTimeout(() => (stopLabel.textContent = 'Arrêter'), 3000);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, select, textarea') || !state?.media || route.name !== 'player') return;
    if (e.code === 'Space' || e.code === 'KeyK') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      conn.send({ t: 'seek', position: player.expected() + (e.code === 'ArrowRight' ? 10 : -10) });
    } else if (e.code === 'Escape' && !document.fullscreenElement) {
      closePlayer();
    }
    wake();
  });

  // Controls fade out while playing, come back on any movement/tap.
  let idleTimer = 0;
  function wake() {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (state?.media && !state.paused && route.name === 'player' && !stage.matches(':focus-within select')) stage.classList.add('idle');
    }, 3000);
  }
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  stage.addEventListener('click', (e) => {
    if (stage.classList.contains('mode-mini') && !(e.target as HTMLElement).closest('button')) openPlayer();
  });

  const label = (id: string) => state?.media?.qualities.find((q) => q.id === id)?.label || id;

  const renderSelects = () => {
    const media = state?.media;
    const qOptions = [
      h('option', { value: 'auto' }, `Auto${player.preference === 'auto' && player.quality ? ` (${label(player.quality)})` : ''}`),
      ...(media?.qualities || []).map((q) => h('option', { value: q.id }, q.label)),
    ];
    clear(qualitySel, qOptions);
    qualitySel.value = player.preference === 'auto' || !media?.qualities.some((q) => q.id === player.preference) ? 'auto' : player.preference;

    clear(audioSel, player.audioTracks.map((t) => h('option', { value: t.id }, t.label)));
    audioSel.value = String(player.audioTrack);
    audioSel.hidden = player.audioTracks.length < 2;

    clear(
      subsSel,
      h('option', { value: 'off' }, 'Sans sous-titres'),
      player.subtitleTracks.length
        ? h('optgroup', { label: 'Dans le fichier' }, player.subtitleTracks.map((t) => h('option', { value: `f:${t.id}` }, t.label)))
        : null,
      subs.options.length
        ? h('optgroup', { label: 'OpenSubtitles' }, subs.options.map((o) => h('option', { value: `x:${o.key}` }, subs.label(o))))
        : null
    );
    subsSel.value = subs.selected ? `x:${subs.selected}` : player.subtitleTrack >= 0 ? `f:${player.subtitleTrack}` : 'off';
    subsSel.hidden = !player.subtitleTracks.length && !subs.options.length;
    subsShift.hidden = !subs.selected;
    shiftLabel.textContent = subs.loading ? '…' : `${subs.offset > 0 ? '+' : ''}${subs.offset} s`;
  };

  const renderOverlay = () => {
    const media = state?.media;
    if (!media) {
      clear(overlay, state ? null : h('div', { class: 'overlay-msg' }, h('span', { class: 'spinner' }), 'Connexion à la salle…'));
      return;
    }
    if (player.error) {
      clear(overlay, h('div', { class: 'overlay-msg' }, h('p', { class: 'auth-error' }, player.error)));
      return;
    }
    if (player.needsGesture) {
      clear(overlay, h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => player.unlock() }, icon('play'), 'Rejoindre la lecture'));
      return;
    }
    const waitingFor = state!.waiting.map((uid) => state!.members.find((m) => m.uid === uid)?.name).filter(Boolean);
    if (waitingFor.length) {
      clear(overlay, h('div', { class: 'overlay-msg' }, h('span', { class: 'spinner' }), `On attend ${waitingFor.join(', ')}…`));
      return;
    }
    clear(overlay);
  };

  const memberChips = (s: RoomState | null) =>
    (s?.members || []).map((m) =>
      h(
        'span',
        {
          class: `member${s!.waiting.includes(m.uid) ? ' waiting' : ''}${m.uid === me.uid ? ' me' : ''}`,
          title: `${m.name}${m.quality ? ` · ${label(m.quality)}` : ''}${s!.waiting.includes(m.uid) ? ' · chargement…' : ''}`,
        },
        avatar(m),
        m.quality && s?.media ? h('span', { class: 'member-q' }, label(m.quality).replace('p', '')) : null
      )
    );

  const renderRoom = () => {
    const s = state;
    status.classList.toggle('on', !!s);
    // Others only: my own avatar is already in the top bar.
    clear(topMembers, memberChips(s && { ...s, members: s.members.filter((m) => m.uid !== me.uid) }));
    clear(stageMembers, memberChips(s));
    const media = s?.media;
    clear(
      stageTitle,
      media?.poster ? h('img', { class: 'stage-poster', src: img(media.poster), alt: '' }) : null,
      media
        ? h(
            'div',
            { class: 'stage-title-text' },
            h('strong', {}, media.title),
            h('span', { class: 'muted-on-media' }, [media.subtitle, `lancé par ${media.startedBy}`].filter(Boolean).join(' · '))
          )
        : null
    );
    miniTitle.textContent = media ? `${media.title}${media.subtitle ? ` · ${media.subtitle.split(' · ')[0]}` : ''}` : '';
    const playing = !!s && !s.paused;
    clear(playBtn, icon(playing ? 'pause' : 'play'));
    clear(miniPlay, icon(playing ? 'pause' : 'play'));
    renderSelects();
    renderOverlay();
    updateStageMode();
  };

  let subsError: string | null = null;
  subs.onChange = () => {
    renderSelects();
    if (subs.error && subs.error !== subsError) toast(`Sous-titres : ${subs.error}`);
    subsError = subs.error;
  };

  player.onChange = () => {
    renderSelects();
    renderOverlay();
  };

  // ------------------------------------------------------------ own progress → account
  let lastSid: string | null = null;
  let lastPos = 0;
  let reportedPos = -1;
  function reportProgress() {
    if (!lastSid || lastPos <= 0 || Math.abs(lastPos - reportedPos) < 1) return;
    conn.send({ t: 'progress', sid: lastSid, position: lastPos });
    reportedPos = lastPos;
  }
  setInterval(reportProgress, PROGRESS_EVERY_MS);
  window.addEventListener('pagehide', reportProgress);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && reportProgress());

  let lastMediaSid: string | null = null;
  conn.onState = (s) => {
    const prev = state;
    const sid = s.media?.sid || null;
    if (sid !== lastMediaSid) {
      // Save where we were in the previous media before switching away.
      reportProgress();
      lastSid = sid;
      lastPos = 0;
      reportedPos = -1;
    } else if (prev && !prev.paused && s.paused) {
      reportProgress();
    }
    state = s;
    player.applyState(s);
    renderRoom();
    if (sid && sid !== lastMediaSid) {
      openPlayer();
      const src = s.media!.source;
      const decodable: Record<string, boolean> = { h264: true, ...player.caps };
      const copied = decodable[src.codec];
      if (src.dolbyVision && !copied) toast('Source Dolby Vision transcodée : les couleurs peuvent être fausses.');
      else if (src.hdr && !copied) toast('Source HDR transcodée : les couleurs peuvent être ternes.');
    }
    if (!sid && route.name === 'player') closePlayer();
    if (sid !== lastMediaSid) subs.load(sid);
    lastMediaSid = sid;
  };
  conn.onNotice = toast;
  conn.onStatus = (on) => status.classList.toggle('on', on);
  conn.connect();

  // External subtitles follow this viewer's own video time.
  setInterval(() => state?.media && subs.render(video.currentTime), 100);

  // Progress bar / clock, from the room position so everyone sees the same thing.
  setInterval(() => {
    const d = state?.media?.duration || 0;
    const pos = state?.media ? player.expected() : 0;
    timeCur.textContent = formatTime(pos);
    timeDur.textContent = formatTime(d);
    if (!scrubbing && d) {
      seek.value = String(Math.round((pos / d) * 1000));
      seek.style.setProperty('--fill', `${((pos / d) * 100).toFixed(2)}%`);
    }
    // This viewer's own position (what gets saved to their account).
    if (state?.media && state.media.sid === lastSid && video.readyState >= 1 && video.currentTime > 0) lastPos = video.currentTime;
  }, 250);

  render();
  renderRoom();
}

boot();
