import './style.css';
import { api, img, type RoomState } from './api.ts';
import type { App, PlayRequest, View } from './app.ts';
import { LoginRequired, loginScreen, signIn, type Identity } from './auth.ts';
import { Connection } from './connection.ts';
import { clear, h, toast } from './dom.ts';
import { parseRoute, routeHref, type Route } from './format.ts';
import { Player } from './player.ts';
import { createStage, memberChips } from './stage.ts';
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

  // ------------------------------------------------------------ player stage (stage.ts)
  const stage = createStage({
    me,
    conn,
    player,
    video,
    state: () => state,
    isOpen: () => route.name === 'player',
    open: () => openPlayer(),
    close: () => closePlayer(),
    stop: () => {
      reportProgress();
      api('/api/room/stop', { method: 'POST' }).catch((err) => toast(err.message));
    },
  });

  clear(root, rail, topbar, content, stage.el, h('div', { id: 'toasts', class: 'toasts' }));

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
    stage.setMode(route.name === 'player' ? 'full' : state?.media ? 'mini' : 'hidden');
  }

  window.addEventListener('hashchange', () => {
    if (parseRoute(location.hash).name !== 'player') playerPushed = false;
    render();
  });

  const renderRoom = () => {
    const s = state;
    status.classList.toggle('on', !!s);
    // Others only: my own avatar is already in the top bar.
    clear(topMembers, memberChips(s && { ...s, members: s.members.filter((m) => m.uid !== me.uid) }, me.uid, stage.label));
    stage.update();
    updateStageMode();
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
    lastMediaSid = sid;
  };
  conn.onNotice = toast;
  conn.onStatus = (on) => status.classList.toggle('on', on);
  conn.connect();

  // This viewer's own position (what gets saved to their account).
  setInterval(() => {
    if (state?.media && state.media.sid === lastSid && video.readyState >= 1 && video.currentTime > 0) lastPos = video.currentTime;
  }, 250);

  render();
  renderRoom();
}

boot();
