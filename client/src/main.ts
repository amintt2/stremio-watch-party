import './style.css';
import { api, img, type RoomState, type User } from './api.ts';
import { openExternal, signIn } from './auth.ts';
import { Browser } from './browse.ts';
import { Connection } from './connection.ts';
import { clear, h, toast } from './dom.ts';
import { Player } from './player.ts';
import { formatTime } from './sync.ts';

const root = document.getElementById('app')!;

async function boot() {
  clear(root, h('div', { class: 'splash' }, h('span', { class: 'spinner' }), 'Connexion…'));
  let user: User;
  try {
    ({ user } = await signIn());
  } catch (err) {
    clear(root, h('div', { class: 'splash' }, h('p', { class: 'auth-error' }, (err as Error).message)));
    return;
  }
  start(user);
}

function start(me: User) {
  const conn = new Connection();
  const video = h('video', { class: 'video', playsinline: true, preload: 'auto' });
  const player = new Player(video, conn);
  const browser = new Browser();
  let state: RoomState | null = null;
  let browseOpen = true;
  let scrubbing = false;

  // ------------------------------------------------------------ layout
  const members = h('div', { class: 'members', 'aria-label': 'Spectateurs' });
  const title = h('div', { class: 'now-title' });
  const browseBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Choisir un film');
  const status = h('span', { class: 'conn-dot', title: 'Connexion' });
  const topbar = h('header', { class: 'topbar' }, h('span', { class: 'logo' }, 'Watch Party'), status, title, members, browseBtn);
  const legalLink = (label: string, href: string) =>
    h('a', { href, onclick: (e: Event) => (e.preventDefault(), openExternal(href)) }, label);
  browser.el.append(
    h('footer', { class: 'legal' }, legalLink('Conditions d’utilisation', '/conditions'), ' · ', legalLink('Confidentialité', '/confidentialite'))
  );

  const playBtn = h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Lecture / pause' }, '▶');
  const seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Position' });
  const time = h('span', { class: 'time' }, '0:00 / 0:00');
  const qualitySel = h('select', { class: 'input input-sm', 'aria-label': 'Qualité' });
  const audioSel = h('select', { class: 'input input-sm', 'aria-label': 'Audio' });
  const subsSel = h('select', { class: 'input input-sm', 'aria-label': 'Sous-titres' });
  const volume = h('input', { class: 'volume', type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  const stopBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Arrêter pour tout le monde' }, 'Arrêter');
  const controls = h(
    'div',
    { class: 'controls' },
    playBtn,
    time,
    seek,
    h('div', { class: 'controls-right' }, qualitySel, audioSel, subsSel, volume, stopBtn)
  );
  const overlay = h('div', { class: 'overlay' });
  const stage = h('main', { class: 'stage' }, video, overlay, controls);
  const drawer = h('div', { class: 'drawer' }, browser.el);
  clear(root, topbar, stage, drawer, h('div', { id: 'toasts', class: 'toasts' }));

  // ------------------------------------------------------------ behaviour
  const setBrowse = (open: boolean) => {
    browseOpen = open;
    drawer.classList.toggle('open', open);
    browseBtn.textContent = open && state?.media ? 'Retour au film' : 'Choisir un film';
    if (open) browser.focus();
  };
  browseBtn.addEventListener('click', () => setBrowse(!browseOpen || !state?.media));
  browser.onStarted = () => setBrowse(false);

  playBtn.addEventListener('click', () => {
    if (!state?.media) return;
    conn.send({ t: state.paused ? 'play' : 'pause' });
  });
  seek.addEventListener('input', () => (scrubbing = true));
  seek.addEventListener('change', () => {
    scrubbing = false;
    const d = state?.media?.duration;
    if (d) conn.send({ t: 'seek', position: (Number(seek.value) / 1000) * d });
  });
  qualitySel.addEventListener('change', () => player.setPreference(qualitySel.value));
  audioSel.addEventListener('change', () => player.setAudioTrack(Number(audioSel.value)));
  subsSel.addEventListener('change', () => player.setSubtitleTrack(Number(subsSel.value)));
  volume.addEventListener('input', () => (video.volume = Number(volume.value)));
  // Two-step confirm: the Discord iframe doesn't allow confirm() dialogs.
  let stopArmed = 0;
  stopBtn.addEventListener('click', () => {
    if (Date.now() - stopArmed < 3000) {
      stopArmed = 0;
      stopBtn.textContent = 'Arrêter';
      api('/api/room/stop', { method: 'POST' }).catch((err) => toast(err.message));
      return;
    }
    stopArmed = Date.now();
    stopBtn.textContent = 'Confirmer ?';
    setTimeout(() => (stopBtn.textContent = 'Arrêter'), 3000);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, select, textarea') || !state?.media) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      conn.send({ t: 'seek', position: player.expected() + (e.code === 'ArrowRight' ? 10 : -10) });
    }
  });

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

    clear(subsSel, h('option', { value: -1 }, 'Sans sous-titres'), player.subtitleTracks.map((t) => h('option', { value: t.id }, t.label)));
    subsSel.value = String(player.subtitleTrack);
    subsSel.hidden = player.subtitleTracks.length === 0;
  };
  const label = (id: string) => state?.media?.qualities.find((q) => q.id === id)?.label || id;

  const renderOverlay = () => {
    const media = state?.media;
    if (!media) {
      clear(overlay, h('div', { class: 'overlay-msg' }, h('p', {}, 'Rien en lecture.'), h('p', { class: 'muted' }, 'Choisis un film : il démarrera pour tout le monde.')));
      return;
    }
    if (player.error) {
      clear(overlay, h('div', { class: 'overlay-msg' }, h('p', { class: 'auth-error' }, player.error)));
      return;
    }
    if (player.needsGesture) {
      clear(overlay, h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => player.unlock() }, '▶ Rejoindre la lecture'));
      return;
    }
    const waitingFor = state!.waiting
      .map((uid) => state!.members.find((m) => m.uid === uid)?.name)
      .filter(Boolean);
    if (waitingFor.length) {
      clear(overlay, h('div', { class: 'overlay-msg' }, h('span', { class: 'spinner' }), `On attend ${waitingFor.join(', ')}…`));
      return;
    }
    clear(overlay);
  };

  const renderRoom = () => {
    const s = state;
    status.classList.toggle('on', !!s);
    clear(
      members,
      (s?.members || []).map((m) =>
        h(
          'span',
          {
            class: `member${s!.waiting.includes(m.uid) ? ' waiting' : ''}${m.uid === me.uid ? ' me' : ''}`,
            title: `${m.name}${m.quality ? ` · ${label(m.quality)}` : ''}`,
          },
          m.avatar ? h('img', { src: img(m.avatar), alt: '' }) : h('span', { class: 'member-initial' }, m.name.slice(0, 1).toUpperCase()),
          m.quality ? h('span', { class: 'member-q' }, label(m.quality).replace('p', '')) : null
        )
      )
    );
    const media = s?.media;
    clear(
      title,
      media ? h('strong', {}, media.title) : null,
      media?.subtitle ? h('span', { class: 'muted' }, ` · ${media.subtitle}`) : null
    );
    stage.classList.toggle('has-media', !!media);
    playBtn.textContent = s && !s.paused ? '❚❚' : '▶';
    renderSelects();
    renderOverlay();
    if (!media && !browseOpen) setBrowse(true);
  };

  player.onChange = () => {
    renderSelects();
    renderOverlay();
  };

  let lastMediaSid: string | null = null;
  conn.onState = (s) => {
    state = s;
    player.applyState(s);
    renderRoom();
    const sid = s.media?.sid || null;
    if (sid && sid !== lastMediaSid) {
      setBrowse(false);
      const src = s.media!.source;
      const decodable: Record<string, boolean> = { h264: true, ...player.caps };
      const copied = decodable[src.codec];
      if (src.dolbyVision && !copied) toast('Source Dolby Vision transcodée : les couleurs peuvent être fausses.');
      else if (src.hdr && !copied) toast('Source HDR transcodée : les couleurs peuvent être ternes.');
    }
    lastMediaSid = sid;
  };
  conn.onNotice = toast;
  conn.onStatus = (on) => status.classList.toggle('on', on);
  conn.connect();

  // Progress bar / clock, from the room position so everyone sees the same thing.
  setInterval(() => {
    const d = state?.media?.duration || 0;
    const pos = state?.media ? player.expected() : 0;
    time.textContent = `${formatTime(pos)} / ${formatTime(d)}`;
    if (!scrubbing && d) seek.value = String(Math.round((pos / d) * 1000));
  }, 250);

  setBrowse(true);
  renderRoom();
}

boot();
