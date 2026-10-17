// The player stage: full-screen player and mini-player, with its controls. Play,
// pause and seek go to the room (everyone follows); volume, quality, audio track,
// subtitles and everything else here is per viewer.
import { api, img, type RoomState, type User, type Member } from './api.ts';
import { Volume } from './audio.ts';
import { localStorageGet, localStorageSet } from './auth.ts';
import type { Connection } from './connection.ts';
import {
  DOUBLE_TAP_MS,
  durationLabel,
  formatDelta,
  formatPercent,
  isDoubleTap,
  nextOption,
  seekRatio,
  seekTarget,
  shortcutAction,
  SHORTCUTS,
  tapZone,
  VOLUME_STEP,
  volumeIcon,
  type Tap,
  type TapZone,
} from './controls.ts';
import { clear, h, toast } from './dom.ts';
import { HEALTH_LABEL, lowerQuality, sourceDetail, sourceProblem, type Health, type SourceHealth } from './health.ts';
import { roomPlayback, type Playback } from './playback.ts';
import type { Player } from './player.ts';
import { SpeechMeter } from './speech.ts';
import { subtitleStyleControls } from './subcontrols.ts';
import { applyStyleVars, onSubtitleStyle, pictureHeight, styleVars, subtitleStyle } from './substyle.ts';
import { cleanVttText, ExternalSubtitles, formatOffset, lineTime } from './subtitles.ts';
import { formatTime } from './sync.ts';
import { avatar, icon } from './ui.ts';

export type StageMode = 'full' | 'mini' | 'hidden';

export interface StageHost {
  me: User;
  conn: Connection;
  /** Room play/pause/seek requests (default: send them to the room as is). */
  playback?: Playback;
  player: Player;
  video: HTMLVideoElement;
  state(): RoomState | null;
  /** The full player is the current page. */
  isOpen(): boolean;
  open(): void;
  close(): void;
  /** "Arrêter pour tout le monde" (confirmed). */
  stop(): void;
  /** Extra buttons in the player's top bar (the room's "Salle" button). */
  topExtra?: HTMLElement[];
  /** Extra classes for a member's avatar chip (host crown). */
  memberClass?: (m: Member) => string;
  /** May this viewer stop the media for everyone? (protected rooms: host / co-pilotes) */
  canStop?: () => boolean;
  /** Extra row of the settings menu ("Ouvrir dans…", externalPlayer.ts); gets a menu closer. */
  menuExtra?: (closeMenu: () => void) => HTMLElement | null;
}

const REMAINING_KEY = 'wp-remaining';
const IDLE_MS = 3000;
/** Room seeks from ±10 s taps/keys are grouped: one seek for the whole burst. */
const SEEK_BURST_MS = 450;
/** "Risque de coupure" shows after this long in the red. */
const POOR_NOTICE_MS = 4000;
/** Phones held upright: picture at the top, details under it (see the CSS "phone player" section). */
const PORTRAIT_MEDIA = '(max-width: 640px) and (orientation: portrait)';
/** Avatars shown in the player's top bar before "+N". */
const MAX_CHIPS = 4;

/** "Toi seul" / "2 spectateurs · toi, Bob". */
export function watchersLabel(members: { uid: string; name: string }[], meUid: string) {
  if (members.length <= 1) return 'Toi seul pour l’instant';
  const names = members.map((m) => (m.uid === meUid ? 'toi' : m.name));
  const list = names.length > 4 ? `${names.slice(0, 3).join(', ')} et ${names.length - 3} autres` : names.join(', ');
  return `${members.length} spectateurs · ${list}`;
}

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type IosVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

/** Avatars of the room members (also used in the top bar). */
export function memberChips(s: RoomState | null, meUid: string, label: (id: string) => string, memberClass?: (m: Member) => string) {
  return (s?.members || []).map((m) =>
    h(
      'span',
      {
        class: `member${s!.waiting.includes(m.uid) ? ' waiting' : ''}${m.external ? ' external' : ''}${m.uid === meUid ? ' me' : ''}${memberClass?.(m) || ''}`,
        title: `${m.name}${m.external ? ' · lecteur externe' : m.quality ? ` · ${label(m.quality)}` : ''}${s!.waiting.includes(m.uid) ? ' · chargement…' : ''}`,
      },
      avatar(m),
      m.quality && s?.media && !m.external ? h('span', { class: 'member-q' }, label(m.quality).replace('p', '')) : null
    )
  );
}

export function createStage(host: StageHost) {
  const { conn, player, video, me } = host;
  // The only way this UI changes the room's playback.
  const playback = host.playback || roomPlayback(conn);
  const iosVideo = video as IosVideo;
  const state = () => host.state();
  const label = (id: string) => state()?.media?.qualities.find((q) => q.id === id)?.label || id;
  let mode: StageMode = 'hidden';
  const iconBtn = (name: string, ariaLabel: string, cls = '') =>
    h('button', { class: `btn btn-ghost btn-icon on-media ${cls}`.trim(), type: 'button', 'aria-label': ariaLabel, title: ariaLabel }, icon(name));
  const setIcon = (btn: HTMLElement, name: string) => {
    if (btn.dataset.icon !== name) {
      btn.dataset.icon = name;
      clear(btn, icon(name));
    }
  };

  // ------------------------------------------------------------ top bar
  const backBtn = iconBtn('back', 'Réduire le lecteur');
  const stageTitle = h('div', { class: 'stage-title' });
  const stageMembers = h('div', { class: 'members', 'aria-label': 'Spectateurs' });
  const stopLabel = h('span', { class: 'btn-label' }, 'Arrêter');
  const stopBtn = h('button', { class: 'btn btn-ghost btn-sm on-media stop-btn', type: 'button', title: 'Arrêter pour tout le monde' }, icon('stop', 'icon icon-sm'), stopLabel);
  // "Qui regarde" (phones in portrait, under the picture).
  const stageWho = h('span', { class: 'stage-who' });
  // Room actions: in the top bar, or under the picture on phones in portrait (see placeLayout).
  const topActions = h('div', { class: 'stage-top-actions' }, ...(host.topExtra || []), h('div', { class: 'stage-members' }, stageMembers, stageWho), stopBtn);
  const stageTop = h('div', { class: 'stage-top' }, backBtn, stageTitle, topActions);

  // ------------------------------------------------------------ seek bar
  const seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Position' });
  const ghost = h('span', { class: 'seek-ghost', title: 'Position de la salle', hidden: true });
  const tip = h('span', { class: 'seek-tip', hidden: true });
  const seekWrap = h('div', { class: 'seek-wrap' }, seek, ghost, tip);
  const timeCur = h('span', { class: 'time' }, '0:00');
  let remaining = localStorageGet(REMAINING_KEY) === '1';
  const timeDur = h('button', { class: 'time time-btn', type: 'button', title: 'Durée / temps restant' }, '0:00');

  // ------------------------------------------------------------ bottom bar
  const playBtn = h('button', { class: 'btn-round', type: 'button', 'aria-label': 'Lecture / pause (pour tout le monde)' }, icon('play'));
  const volume = new Volume(video);
  const muteBtn = iconBtn('volume', 'Couper le son (M)', 'mute-btn');
  const menuMute = iconBtn('volume', 'Couper le son (M)');
  const volSlider = () => h('input', { class: 'volume', type: 'range', min: 0, max: volume.max, step: 1, value: volume.pct, 'aria-label': 'Volume' });
  const volInline = volSlider();
  const volLabel = h('span', { class: 'volume-pct' });
  const volGroup = h('span', { class: 'volume-group' }, muteBtn, volInline, volLabel);
  const healthBtn = h('button', { class: 'health', type: 'button', 'aria-label': 'Qualité de la connexion' }, h('span', { class: 'health-dot' }));
  const pipBtn = iconBtn('pip', 'Image dans l’image', 'pip-btn');
  const gearBtn = iconBtn('settings', 'Réglages', 'gear-btn');
  gearBtn.setAttribute('aria-haspopup', 'true');
  const fsBtn = iconBtn('fullscreen', 'Plein écran (F)');
  const controls = h(
    'div',
    { class: 'controls' },
    h('div', { class: 'seek-row' }, timeCur, seekWrap, timeDur),
    h('div', { class: 'controls-row' }, playBtn, volGroup, healthBtn, h('div', { class: 'controls-right' }, pipBtn, gearBtn, fsBtn))
  );

  // ------------------------------------------------------------ layers
  const subsLayer = h('div', { class: 'subs' });
  const subs = new ExternalSubtitles(subsLayer);
  const overlay = h('div', { class: 'overlay' });
  const notice = h('div', { class: 'stage-notice', role: 'status', 'aria-live': 'polite', hidden: true });
  const rippleL = h('div', { class: 'ripple ripple-left', 'aria-hidden': 'true' });
  const rippleR = h('div', { class: 'ripple ripple-right', 'aria-hidden': 'true' });
  const flash = h('div', { class: 'stage-flash', 'aria-hidden': 'true' });
  const menu = h('div', { class: 'stage-menu', role: 'dialog', 'aria-label': 'Réglages du lecteur', hidden: true });
  const help = h('div', { class: 'stage-menu stage-help', role: 'dialog', 'aria-label': 'Raccourcis clavier', hidden: true });

  // ------------------------------------------------------------ mini-player
  const miniPlay = iconBtn('play', 'Lecture / pause');
  const miniTitle = h('span', { class: 'mini-title' });
  const miniBar = h('div', { class: 'mini-bar' }, miniTitle, miniPlay, iconBtn('expand', 'Agrandir', 'mini-expand'));

  // ------------------------------------------------------------ phone in portrait
  // The picture sits at the top (16:9) with its controls attached under it; the space
  // left below gets the title, who is watching and the room actions (like YouTube's app).
  const stageInfo = h('div', { class: 'stage-info' });

  const el = h(
    'section',
    { class: 'stage mode-hidden', 'aria-label': 'Lecteur' },
    video,
    subsLayer,
    overlay,
    rippleL,
    rippleR,
    flash,
    stageTop,
    notice,
    controls,
    stageInfo,
    menu,
    help,
    miniBar
  );

  const portraitQuery = matchMedia(PORTRAIT_MEDIA);
  function placeLayout() {
    const portrait = portraitQuery.matches && !el.classList.contains('is-fullscreen');
    el.classList.toggle('portrait', portrait);
    if (portrait && stageTitle.parentElement !== stageInfo) stageInfo.append(stageTitle, topActions);
    else if (!portrait && stageTitle.parentElement !== stageTop) {
      backBtn.after(stageTitle);
      stageTop.append(topActions);
    }
  }
  portraitQuery.addEventListener('change', placeLayout);
  placeLayout();

  // ------------------------------------------------------------ room actions
  const togglePlay = () => {
    const s = state();
    if (!s?.media) return;
    if (s.paused) playback.requestPlay();
    else playback.requestPause();
    showFlash(icon(s.paused ? 'play' : 'pause', 'icon icon-xl'));
  };

  let burst: { delta: number; timer: number } | null = null;
  function seekBy(delta: number, side?: TapZone) {
    const media = state()?.media;
    if (!media) return;
    if (!burst) burst = { delta: 0, timer: 0 };
    burst.delta += delta;
    clearTimeout(burst.timer);
    ripple(side === 'left' || (!side && burst.delta < 0) ? rippleL : rippleR, formatDelta(burst.delta), burst.delta < 0 ? 'back' : 'forward');
    burst.timer = window.setTimeout(() => {
      const d = burst!.delta;
      burst = null;
      playback.requestSeek(seekTarget(player.expected(), d, media.duration || 0));
    }, SEEK_BURST_MS);
  }

  function ripple(target: HTMLElement, text: string, dir: string) {
    clear(target, h('span', { class: 'ripple-text' }, dir === 'back' ? '«' : '»', ' ', text));
    target.classList.remove('show');
    void target.offsetWidth;
    target.classList.add('show');
  }

  let flashTimer = 0;
  function showFlash(content: Node | string) {
    clear(flash, content);
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => flash.classList.remove('show'), 700);
  }

  // Two-step confirm (the Discord iframe doesn't allow confirm() dialogs). The label
  // shows even on phones while armed, where the button is otherwise icon-only.
  let stopTimer = 0;
  const disarmStop = () => {
    clearTimeout(stopTimer);
    stopBtn.classList.remove('armed');
    stopLabel.textContent = 'Arrêter';
  };
  stopBtn.addEventListener('click', () => {
    if (stopBtn.classList.contains('armed')) {
      disarmStop();
      host.stop();
      return;
    }
    stopBtn.classList.add('armed');
    stopLabel.textContent = 'Confirmer ?';
    stopTimer = window.setTimeout(disarmStop, 3500);
    wake();
  });

  // ------------------------------------------------------------ fullscreen / PiP
  const doc = document as Doc;
  const fsElement = () => doc.fullscreenElement || doc.webkitFullscreenElement || null;

  async function toggleFullscreen() {
    if (fsElement()) {
      try {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else doc.webkitExitFullscreen?.();
      } catch {
        /* already out */
      }
      return;
    }
    const target = el as FsElement;
    try {
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
      else throw new Error('unsupported');
      // Phones: turn to landscape for a landscape video, when the browser allows it.
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (matchMedia('(pointer: coarse)').matches && video.videoWidth >= video.videoHeight && orientation?.lock) {
        orientation.lock('landscape').catch(() => {});
      }
      return;
    } catch {
      /* blocked (Discord iframe) or unsupported: try the video alone (iPhone) */
    }
    if (iosVideo.webkitEnterFullscreen && iosVideo.webkitSupportsFullscreen) {
      try {
        iosVideo.webkitEnterFullscreen();
        return;
      } catch {
        /* fall through */
      }
    }
    toast('Plein écran indisponible ici');
  }

  const toastsHost = () => document.getElementById('toasts');
  const onFullscreenChange = () => {
    const full = fsElement() === el;
    el.classList.toggle('is-fullscreen', full);
    placeLayout();
    setIcon(fsBtn, full ? 'fullscreen-exit' : 'fullscreen');
    fsBtn.setAttribute('aria-label', full ? 'Quitter le plein écran (F)' : 'Plein écran (F)');
    fsBtn.title = fsBtn.getAttribute('aria-label')!;
    // Toasts live outside the stage: bring them in while it is fullscreen.
    const toasts = toastsHost();
    if (toasts) {
      if (full) el.append(toasts);
      else if (toasts.parentElement === el) el.parentElement?.append(toasts);
    }
    if (!full) {
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* not locked */
      }
    }
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  const pipSupported = () =>
    (!!document.pictureInPictureEnabled && !video.disablePictureInPicture) || !!iosVideo.webkitSupportsPresentationMode?.('picture-in-picture');
  pipBtn.hidden = !pipSupported();
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture && document.pictureInPictureEnabled) await video.requestPictureInPicture();
      else if (iosVideo.webkitSetPresentationMode)
        iosVideo.webkitSetPresentationMode(iosVideo.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      else throw new Error('unsupported');
    } catch {
      toast('Image dans l’image indisponible ici');
    }
  });

  // ------------------------------------------------------------ volume
  volume.onError = toast;
  const menuVol = volSlider();
  const volSliders = [volInline, menuVol];
  const renderVolume = () => {
    const shown = volume.muted ? 0 : volume.pct;
    for (const s of volSliders) {
      s.max = String(volume.max);
      if (document.activeElement !== s || s.value !== String(volume.pct)) s.value = String(volume.pct);
      s.style.setProperty('--fill', `${((shown / volume.max) * 100).toFixed(1)}%`);
      s.style.setProperty('--mark', `${((100 / volume.max) * 100).toFixed(1)}%`);
      s.classList.toggle('boost', volume.max > 100);
    }
    const text = volume.muted ? 'Muet' : formatPercent(volume.pct);
    volLabel.textContent = text;
    for (const l of el.querySelectorAll('.menu-volume-pct')) l.textContent = text;
    for (const b of [muteBtn, menuMute]) {
      setIcon(b, volumeIcon(volume.pct, volume.muted));
      b.setAttribute('aria-label', volume.muted ? 'Remettre le son (M)' : 'Couper le son (M)');
      b.title = b.getAttribute('aria-label')!;
    }
    el.classList.toggle('no-volume-slider', !volume.adjustable);
  };
  volume.onChange = renderVolume;
  const bindVolumeSlider = (s: HTMLInputElement) => {
    s.addEventListener('input', () => volume.set(Number(s.value)));
    s.addEventListener('pointerdown', () => (adjusting = true));
    s.addEventListener('change', () => ((adjusting = false), wake()));
  };
  bindVolumeSlider(volInline);
  bindVolumeSlider(menuVol);
  muteBtn.addEventListener('click', () => volume.toggleMute());
  menuMute.addEventListener('click', () => volume.toggleMute());
  const nudgeVolume = (delta: number) => {
    volume.set((volume.muted ? 0 : volume.pct) + delta);
    showFlash(h('span', { class: 'flash-text' }, icon(volumeIcon(volume.pct, volume.muted), 'icon'), formatPercent(volume.pct)));
  };
  // Any gesture can start or resume the Web Audio route (browsers require one).
  const gesture = () => volume.gesture();
  document.addEventListener('pointerdown', gesture, true);
  document.addEventListener('keydown', gesture, true);

  // ------------------------------------------------------------ subtitles
  // Style: sizes follow the picture's height (letterbox included), like on a TV.
  const applySubStyle = () => {
    const box = (mode === 'full' ? video : el).getBoundingClientRect();
    const height = pictureHeight(box.width, box.height, video.videoWidth, video.videoHeight);
    applyStyleVars(el, styleVars(subtitleStyle(), height || 360, box.height || height || 360));
  };
  const subObserver = new ResizeObserver(applySubStyle);
  subObserver.observe(el);
  subObserver.observe(video);
  video.addEventListener('loadedmetadata', applySubStyle);
  video.addEventListener('resize', applySubStyle);
  onSubtitleStyle(applySubStyle);
  applySubStyle();

  // Auto-sync listens to the film's voices (this viewer's own playback, nothing sent).
  const speech = new SpeechMeter(video, () => volume.analyser());
  const wantsAudioSync = () => !!subs.selected && subs.auto && !['file', 'manual', 'reference'].includes(subs.method);
  setInterval(() => {
    if (wantsAudioSync()) {
      speech.start();
      subs.listen(speech.samples);
    } else speech.stop();
  }, 3000);
  subs.onAutoSync = (message) => toast(message);

  /** The file's own subtitle track: cues in a hidden text track, drawn by the overlay. */
  function fileTrackLines(): string[] {
    const tracks = [...video.textTracks].filter((t) => (t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'hidden');
    const track = tracks[tracks.length - 1];
    if (!track?.activeCues) return [];
    return [...track.activeCues].map((c) => cleanVttText((c as VTTCue).text || '')).filter(Boolean);
  }

  /** "off", "f:<file track>" or "x:<OpenSubtitles key>": one subtitle at a time. */
  const subtitleValue = () => (subs.selected ? `x:${subs.selected}` : player.subtitleTrack >= 0 ? `f:${player.subtitleTrack}` : 'off');
  const subtitleValues = () => ['off', ...player.subtitleTracks.map((t) => `f:${t.id}`), ...subs.options.map((o) => `x:${o.key}`)];
  function setSubtitle(value: string) {
    const [kind, id] = value.split(/:(.*)/s);
    if (kind !== 'f' && player.subtitleTrack >= 0) player.setSubtitleTrack(-1);
    if (kind === 'f') {
      if (subs.selected) subs.select(null);
      player.setSubtitleTrack(Number(id));
    } else subs.select(kind === 'x' ? id : null);
  }
  const subtitleLabel = (value: string) => {
    if (value === 'off') return 'Désactivés';
    const [kind, id] = value.split(/:(.*)/s);
    if (kind === 'f') return player.subtitleTracks.find((t) => String(t.id) === id)?.label || 'Piste';
    const o = subs.options.find((x) => x.key === id);
    return o ? subs.label(o) : '…';
  };
  function cycleSubtitles() {
    const values = subtitleValues();
    if (values.length < 2) {
      showFlash(h('span', { class: 'flash-text' }, 'Aucun sous-titre'));
      return;
    }
    const next = nextOption(values, subtitleValue());
    setSubtitle(next);
    showFlash(h('span', { class: 'flash-text' }, `Sous-titres : ${subtitleLabel(next)}`));
  }

  let subsError: string | null = null;
  subs.onChange = () => {
    renderMenu();
    if (subs.error && subs.error !== subsError) toast(`Sous-titres : ${subs.error}`);
    subsError = subs.error;
  };

  // ------------------------------------------------------------ settings menu
  type Page = 'main' | 'quality' | 'audio' | 'subs' | 'sync' | 'heard' | 'style';
  let page: Page = 'main';
  const menuOpen = () => !menu.hidden || !help.hidden;

  function openMenu(p: Page = 'main') {
    help.hidden = true;
    page = p;
    menu.hidden = false;
    gearBtn.setAttribute('aria-expanded', 'true');
    el.classList.add('menu-open');
    renderMenu(true);
    wake();
    (menu.querySelector('button, input') as HTMLElement | null)?.focus({ preventScroll: true });
  }
  function closeMenus() {
    const wasOpen = menuOpen();
    menu.hidden = true;
    help.hidden = true;
    gearBtn.setAttribute('aria-expanded', 'false');
    el.classList.remove('menu-open');
    wake();
    return wasOpen;
  }
  function openHelp() {
    menu.hidden = true;
    help.hidden = false;
    el.classList.add('menu-open');
    clear(
      help,
      h('div', { class: 'menu-head' }, h('strong', {}, 'Raccourcis clavier'), h('button', { class: 'btn btn-ghost btn-icon on-media', type: 'button', 'aria-label': 'Fermer', onclick: () => closeMenus() }, icon('close'))),
      h('dl', { class: 'keys' }, SHORTCUTS.flatMap(([k, v]) => [h('dt', {}, ...k.split(' / ').flatMap((x, i) => [i ? ' / ' : '', h('kbd', {}, x)])), h('dd', {}, v)]))
    );
    wake();
  }
  gearBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenus()));

  const row = (title: string, value: string, go: Page) =>
    h(
      'button',
      { class: 'menu-row', type: 'button', onclick: () => ((page = go), renderMenu(true), (menu.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true })) },
      h('span', { class: 'menu-row-title' }, title),
      h('span', { class: 'menu-row-value' }, value),
      icon('chevron', 'icon icon-sm')
    );
  const choice = (text: string, selected: boolean, onPick: () => void) =>
    h(
      'button',
      { class: `menu-choice${selected ? ' selected' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(selected), onclick: () => (onPick(), (page = 'main'), renderMenu(true)) },
      h('span', { class: 'menu-check' }, selected ? icon('check', 'icon icon-sm') : null),
      text
    );
  const subPage = (title: string, ...items: (Node | null)[]) =>
    [
      h(
        'button',
        { class: 'menu-row menu-back', type: 'button', onclick: () => ((page = 'main'), renderMenu(true)) },
        icon('back', 'icon icon-sm'),
        h('span', { class: 'menu-row-title' }, title)
      ),
      h('div', { class: 'menu-list', role: 'menu' }, items),
    ];

  let menuKey = '';
  function renderMenu(force = false) {
    if (menu.hidden) return;
    const media = state()?.media;
    // Room updates arrive often: rebuild only when something shown here changed
    // (and never under a finger dragging the volume).
    const key = JSON.stringify([
      page,
      media?.sid,
      media?.qualities.length,
      player.preference,
      player.quality,
      player.audioTracks,
      player.audioTrack,
      player.subtitleTracks,
      player.subtitleTrack,
      subs.options.length,
      subs.selected,
      subs.loading,
      subs.timing,
      subs.method,
      subs.syncing,
      subs.auto,
    ]);
    if (!force && (key === menuKey || adjusting)) return;
    menuKey = key;
    const qualityText = player.preference === 'auto' ? `Auto${player.quality ? ` (${label(player.quality)})` : ''}` : label(player.preference);
    if (page === 'quality') {
      clear(
        menu,
        subPage(
          'Qualité',
          choice(`Auto${player.quality && player.preference === 'auto' ? ` (${label(player.quality)})` : ''}`, player.preference === 'auto', () => player.setPreference('auto')),
          ...(media?.qualities || []).map((q) => choice(q.label, player.preference === q.id, () => player.setPreference(q.id)))
        )
      );
      return;
    }
    if (page === 'audio') {
      clear(menu, subPage('Audio', ...player.audioTracks.map((t) => choice(t.label, player.audioTrack === t.id, () => player.setAudioTrack(t.id)))));
      return;
    }
    if (page === 'subs') {
      const current = subtitleValue();
      clear(
        menu,
        subPage(
          'Sous-titres',
          choice('Désactivés', current === 'off', () => setSubtitle('off')),
          player.subtitleTracks.length ? h('div', { class: 'menu-group' }, 'Dans le fichier') : null,
          ...player.subtitleTracks.map((t) => choice(t.label, current === `f:${t.id}`, () => setSubtitle(`f:${t.id}`))),
          subs.options.length ? h('div', { class: 'menu-group' }, 'OpenSubtitles') : null,
          ...subs.options.map((o) => {
            const c = choice(subs.label(o), current === `x:${o.key}`, () => setSubtitle(`x:${o.key}`));
            if (o.match) c.append(h('span', { class: `menu-badge${o.match === 'hash' ? ' menu-badge-good' : ''}`, title: o.release || '' }, o.match === 'hash' ? 'Fait pour ce fichier' : 'Même version'));
            if (o.release) c.title = o.release;
            return c;
          })
        )
      );
      return;
    }
    if (page === 'style') {
      clear(
        menu,
        subPage(
          'Style des sous-titres',
          subtitleStyleControls({ media: true, compact: true }),
          h('a', { class: 'menu-row menu-link', href: '#/settings', onclick: () => host.close() }, h('span', { class: 'menu-row-title' }, 'Plus de réglages (contour, ombre, fond…)'), icon('chevron', 'icon icon-sm'))
        )
      );
      return;
    }
    if (page === 'heard') {
      const now = video.currentTime;
      const lines = subs.nearbyLines(now, 5);
      clear(
        menu,
        subPage(
          'Quelle réplique viens-tu d’entendre ?',
          h('p', { class: 'menu-help' }, 'Clique dessus juste après l’avoir entendue : les sous-titres se calent dessus.'),
          ...(lines.length
            ? lines.map((cue) =>
                h(
                  'button',
                  {
                    class: 'menu-choice menu-line',
                    type: 'button',
                    onclick: () => {
                      subs.heardNow(cue, video.currentTime);
                      page = 'main';
                      renderMenu(true);
                      toast(`Sous-titres calés (${formatOffset(subs.timing.offset)})`);
                    },
                  },
                  h('span', { class: 'menu-line-time' }, lineTime(cue, subs.timing)),
                  h('span', { class: 'menu-line-text' }, cue.text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n/g, ' '))
                )
              )
            : [h('div', { class: 'menu-item menu-muted' }, 'Aucune réplique autour de ce moment')])
        )
      );
      return;
    }
    if (page === 'sync') {
      const nudge = (delta: number, text: string, title: string) =>
        h('button', { class: 'btn btn-ghost btn-sm on-media', type: 'button', title, onclick: () => subs.shift(delta) }, text);
      clear(
        menu,
        subPage(
          'Synchronisation',
          h('div', { class: 'menu-item menu-sync-status' }, h('span', { class: `sync-dot sync-${subs.method}${subs.syncing ? ' sync-busy' : ''}` }), subs.syncLabel()),
          h(
            'div',
            { class: 'menu-item' },
            h('span', { class: 'menu-row-title' }, 'Décalage'),
            h(
              'div',
              { class: 'menu-inline menu-nudges', role: 'group', 'aria-label': 'Décalage des sous-titres' },
              nudge(-1, '−1 s', 'Sous-titres 1 s plus tôt'),
              nudge(-0.1, '−0,1', 'Sous-titres 0,1 s plus tôt (G)'),
              h('span', { class: 'menu-value' }, formatOffset(subs.timing.offset)),
              nudge(0.1, '+0,1', 'Sous-titres 0,1 s plus tard (H)'),
              nudge(1, '+1 s', 'Sous-titres 1 s plus tard')
            )
          ),
          h(
            'button',
            { class: 'menu-row', type: 'button', onclick: () => ((page = 'heard'), renderMenu(true)) },
            h('span', { class: 'menu-row-title' }, 'Caler sur une réplique entendue'),
            icon('chevron', 'icon icon-sm')
          ),
          h(
            'div',
            { class: 'menu-item' },
            h('span', { class: 'menu-row-title' }, 'Synchro automatique'),
            h(
              'div',
              { class: 'segmented segmented-media', role: 'radiogroup', 'aria-label': 'Synchro automatique' },
              [true, false].map((on) =>
                h('button', { type: 'button', role: 'radio', 'aria-checked': String(subs.auto === on), class: subs.auto === on ? 'active' : '', onclick: () => (subs.auto = on) }, on ? 'Oui' : 'Non')
              )
            )
          ),
          subs.method !== 'none' && subs.method !== 'file'
            ? h('button', { class: 'menu-row', type: 'button', onclick: () => subs.resetTiming() }, h('span', { class: 'menu-row-title' }, 'Revenir au calage d’origine'))
            : null
        )
      );
      return;
    }
    const hasSubs = player.subtitleTracks.length > 0 || subs.options.length > 0;
    clear(
      menu,
      h(
        'div',
        { class: 'menu-item menu-volume' },
        h('span', { class: 'menu-row-title' }, 'Volume'),
        h(
          'div',
          { class: 'menu-inline' },
          menuMute,
          menuVol,
          h('span', { class: 'volume-pct menu-volume-pct' })
        )
      ),
      row('Qualité', qualityText, 'quality'),
      player.audioTracks.length > 1 ? row('Audio', player.audioTracks.find((t) => t.id === player.audioTrack)?.label || '', 'audio') : null,
      hasSubs || subs.loading ? row('Sous-titres', subs.loading ? 'Chargement…' : subtitleLabel(subtitleValue()), 'subs') : h('div', { class: 'menu-item menu-muted' }, 'Pas de sous-titres pour cette vidéo'),
      subs.selected ? row('Synchronisation', subs.syncing ? 'Recherche…' : formatOffset(subs.timing.offset), 'sync') : null,
      hasSubs ? row('Style des sous-titres', '', 'style') : null,
      host.menuExtra?.(closeMenus) || null,
      // Phones: the bar keeps only the essentials, picture-in-picture moves here.
      pipBtn.hidden
        ? null
        : h('button', { class: 'menu-row menu-phone-only', type: 'button', onclick: () => (closeMenus(), pipBtn.click()) }, icon('pip', 'icon icon-sm'), h('span', { class: 'menu-row-title' }, 'Image dans l’image')),
      h('button', { class: 'menu-row menu-keys', type: 'button', onclick: openHelp }, icon('keyboard', 'icon icon-sm'), h('span', { class: 'menu-row-title' }, 'Raccourcis clavier'), h('kbd', {}, '?'))
    );
    renderVolume();
  }

  // ------------------------------------------------------------ idle (controls fade out)
  let idleTimer = 0;
  let overControls = false;
  let scrubbing = false;
  let adjusting = false;
  const canIdle = () => {
    const s = state();
    return !!s?.media && !s.paused && mode === 'full' && !menuOpen() && !overControls && !scrubbing && !adjusting && !stopBtn.classList.contains('armed');
  };
  function wake() {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => canIdle() && el.classList.add('idle'), IDLE_MS);
  }
  const hideControls = () => {
    if (menuOpen()) return;
    clearTimeout(idleTimer);
    el.classList.add('idle');
  };
  for (const zone of [controls, stageTop]) {
    zone.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && ((overControls = true), wake()));
    zone.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && ((overControls = false), wake()));
  }
  // Keyboard focus inside the controls keeps them up too.
  el.addEventListener('focusin', (e) => !isSurface(e.target) && wake());

  // ------------------------------------------------------------ click / tap on the picture
  const isSurface = (t: EventTarget | null) => t === video || t === el || t === overlay || t === subsLayer || (t instanceof Node && subsLayer.contains(t));
  let lastTouch = 0;
  let down: { x: number; y: number; t: number; id: number } | null = null;
  let lastTap: Tap | null = null;
  let tapTimer = 0;
  let clickTimer = 0;

  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') wake();
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') {
      lastTouch = Date.now();
      down = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      if (!isSurface(e.target)) wake();
    } else wake();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    lastTouch = Date.now();
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId || mode !== 'full' || !isSurface(e.target)) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || Date.now() - d.t > 500) return;
    onTap(e.clientX);
  });
  el.addEventListener('pointercancel', () => (down = null));

  function onTap(clientX: number) {
    if (menuOpen()) {
      closeMenus();
      return;
    }
    // Decided now: anything that wakes the controls meanwhile must not turn this tap
    // into "hide" (they vanished a fraction of a second after showing).
    const wasIdle = el.classList.contains('idle');
    const rect = el.getBoundingClientRect();
    const tap = { t: Date.now(), x: clientX - rect.left };
    if (state()?.media && isDoubleTap(lastTap, tap, rect.width)) {
      clearTimeout(tapTimer);
      const zone = tapZone(tap.x, rect.width);
      seekBy(zone === 'left' ? -10 : 10, zone);
      lastTap = tap; // a third tap keeps going
      return;
    }
    lastTap = tap;
    clearTimeout(tapTimer);
    // Single tap: show / hide the controls, never play/pause (that's the big button).
    tapTimer = window.setTimeout(() => (wasIdle ? wake() : hideControls()), DOUBLE_TAP_MS);
  }

  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (mode === 'mini') {
      if (!target.closest('button')) host.open();
      return;
    }
    if (mode !== 'full' || !isSurface(target)) return;
    const touch = (e as PointerEvent).pointerType === 'touch' || (e as PointerEvent).pointerType === 'pen' || Date.now() - lastTouch < 800;
    if (touch) return;
    if (closeMenus()) return;
    clearTimeout(clickTimer);
    // Wait for a possible double click (fullscreen) so it doesn't pause the room twice.
    if (e.detail <= 1) clickTimer = window.setTimeout(togglePlay, 250);
  });
  el.addEventListener('dblclick', (e) => {
    if (mode !== 'full' || !isSurface(e.target) || Date.now() - lastTouch < 800) return;
    clearTimeout(clickTimer);
    void toggleFullscreen();
  });

  // ------------------------------------------------------------ buttons
  backBtn.addEventListener('click', () => host.close());
  playBtn.addEventListener('click', togglePlay);
  miniPlay.addEventListener('click', togglePlay);
  miniBar.querySelector('.mini-expand')!.addEventListener('click', () => host.open());
  fsBtn.addEventListener('click', () => void toggleFullscreen());
  timeDur.addEventListener('click', () => {
    remaining = !remaining;
    localStorageSet(REMAINING_KEY, remaining ? '1' : '0');
    tick();
  });

  // Seek bar: hover/drag preview, then one room seek on release.
  const thumb = 14;
  const showTip = (ratio: number) => {
    const d = state()?.media?.duration;
    if (!d) return;
    tip.hidden = false;
    tip.textContent = formatTime(ratio * d);
    tip.style.left = `calc(${thumb / 2}px + (100% - ${thumb}px) * ${ratio.toFixed(4)})`;
  };
  seekWrap.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || scrubbing) return;
    const r = seek.getBoundingClientRect();
    showTip(seekRatio(e.clientX, r.left, r.width, thumb));
  });
  seekWrap.addEventListener('pointerleave', () => !scrubbing && (tip.hidden = true));
  seek.addEventListener('input', () => {
    scrubbing = true;
    const ratio = Number(seek.value) / 1000;
    showTip(ratio);
    seek.style.setProperty('--fill', `${(ratio * 100).toFixed(2)}%`);
    const d = state()?.media?.duration;
    if (d) timeCur.textContent = formatTime(ratio * d);
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    tip.hidden = true;
    const d = state()?.media?.duration;
    if (d) playback.requestSeek((Number(seek.value) / 1000) * d);
    wake();
  });

  // ------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    if (!host.isOpen() || !state()?.media) return;
    const t = e.target as HTMLElement;
    if (t.closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    if (t.closest?.('.topbar, .rail, .content')) return;
    const action = shortcutAction(e);
    if (!action) return;
    // Enter/Space on a focused button keeps its own meaning.
    if (action === 'toggle' && e.key === ' ' && t.closest('button') && el.contains(t)) {
      e.preventDefault();
      t.click();
      return;
    }
    if (action !== 'escape') e.preventDefault();
    switch (action) {
      case 'toggle':
        togglePlay();
        break;
      case 'back':
        seekBy(-10);
        break;
      case 'forward':
        seekBy(10);
        break;
      case 'volume-up':
        nudgeVolume(VOLUME_STEP);
        break;
      case 'volume-down':
        nudgeVolume(-VOLUME_STEP);
        break;
      case 'mute':
        volume.toggleMute();
        showFlash(h('span', { class: 'flash-text' }, icon(volumeIcon(volume.pct, volume.muted), 'icon'), volume.muted ? 'Muet' : formatPercent(volume.pct)));
        break;
      case 'fullscreen':
        void toggleFullscreen();
        break;
      case 'subtitles':
        cycleSubtitles();
        break;
      case 'subs-earlier':
      case 'subs-later':
        if (!subs.selected) {
          showFlash(h('span', { class: 'flash-text' }, player.subtitleTrack >= 0 ? 'Décalage : sous-titres OpenSubtitles seulement' : 'Aucun sous-titre'));
          break;
        }
        subs.shift(action === 'subs-earlier' ? -0.1 : 0.1);
        showFlash(h('span', { class: 'flash-text' }, `Sous-titres : ${formatOffset(subs.timing.offset)}`));
        break;
      case 'help':
        if (help.hidden) openHelp();
        else closeMenus();
        break;
      case 'escape':
        if (closeMenus()) break;
        if (fsElement()) break; // the browser leaves fullscreen itself
        host.close();
        break;
    }
    wake();
  });
  // Space was handled on keydown: don't let the focused button click again on keyup.
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && host.isOpen() && (e.target as HTMLElement).closest?.('button') && el.contains(e.target as Node)) e.preventDefault();
  });

  // Click outside the menu closes it.
  el.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (menuOpen() && !menu.contains(t) && !help.contains(t) && !gearBtn.contains(t) && !isSurface(t)) closeMenus();
  });

  // ------------------------------------------------------------ overlay & notices
  let overlayKey = '';
  function renderOverlay() {
    const s = state();
    const media = s?.media;
    let key: string;
    let content: () => Node | null;
    const msg = (text: string, spin = true) => () => h('div', { class: 'overlay-msg' }, spin ? h('span', { class: 'spinner' }) : null, text);
    if (!media) {
      key = s ? 'none' : 'connecting';
      content = s ? () => null : msg('Connexion à la salle…');
    } else if (player.error) {
      key = `error:${player.error}`;
      content = () => h('div', { class: 'overlay-msg' }, h('p', { class: 'auth-error' }, player.error));
    } else if (player.needsGesture) {
      key = 'gesture';
      content = () =>
        h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => (volume.gesture(), player.unlock()) }, icon('play'), 'Rejoindre la lecture');
    } else {
      const waitingFor = s!.waiting.map((uid) => s!.members.find((m) => m.uid === uid)?.name).filter(Boolean);
      const buffering = s!.running && video.readyState < 3 && !video.paused;
      if (waitingFor.length) {
        key = `wait:${waitingFor.join(',')}`;
        content = msg(`On attend ${waitingFor.join(', ')}…`);
      } else if (buffering && mode === 'full') {
        key = 'buffering';
        content = () => h('div', { class: 'overlay-spinner', role: 'status', 'aria-label': 'Chargement…' }, h('span', { class: 'spinner spinner-lg' }));
      } else {
        key = '';
        content = () => null;
      }
    }
    if (key === overlayKey) return;
    overlayKey = key;
    clear(overlay, content());
  }

  // "Risque de coupure": the buffer health in the bar, and a notice when it stays red.
  let poorSince = 0;
  let quietUntil = 0;
  let dismissed = '';
  let noticeKey = '';
  let health: Health | null = null;
  // The server's view of a torrent source (peers, speed vs the video's bitrate).
  let source: SourceHealth | null = null;
  let sourceSince = 0;
  const SOURCE_NOTICE_MS = 4000;
  let sourceSid: string | null = null;
  async function pollSource() {
    const sid = state()?.media?.sid || null;
    if (sid !== sourceSid) source = null;
    sourceSid = sid;
    if (!sid || source?.kind === 'http' || source?.level === 'done') return;
    try {
      const next = await api<SourceHealth>(`/api/media/${encodeURIComponent(sid)}/health`);
      if (state()?.media?.sid === sid) source = next;
    } catch {
      /* the next poll will tell */
    }
  }
  setInterval(pollSource, 10_000);

  function renderHealth() {
    const s = state();
    const now = Date.now();
    const active = !!s?.media && video.readyState >= 1 && !player.error;
    health = active && now > quietUntil ? player.health() : null;
    healthBtn.dataset.level = health || 'idle';
    const ahead = player.bufferAhead();
    const ratio = player.downloadRatio;
    const detail = [
      `Tampon : ${Math.round(ahead)} s`,
      ratio !== null ? `téléchargement ${ratio.toFixed(1).replace('.', ',')}× plus rapide que la lecture` : '',
      sourceDetail(source),
    ]
      .filter(Boolean)
      .join(' · ');
    healthBtn.title = health ? `${HEALTH_LABEL[health]} · ${detail}` : 'Connexion : mesure en cours';
    healthBtn.setAttribute('aria-label', healthBtn.title);
    healthBtn.hidden = !active;

    if (health === 'poor' && s?.running) poorSince ||= now;
    else if (health !== 'poor') poorSince = 0;

    let key = '';
    let content: (Node | string | null)[] = [];
    const lower = lowerQuality(player.ladder, player.quality);
    const slowKey = `${s?.media?.sid}:${player.quality}`;
    // Stuck: loading, catching up, or the room waiting for someone, while it should play.
    const stuck = !!s?.media && !player.error && (s.waiting.length > 0 || player.catchingUp || (s.running && video.readyState < 3));
    const problem = sourceProblem(source, health, stuck);
    if (problem) sourceSince ||= now;
    else sourceSince = 0;
    if (problem && now - sourceSince > SOURCE_NOTICE_MS && dismissed !== `src:${slowKey}`) {
      // The server can't get the file fast enough: a lower quality won't help.
      key = `slow-source:${problem}`;
      content = [
        h('span', { class: 'notice-dot' }),
        problem,
        h('button', { class: 'btn btn-ghost btn-icon btn-icon-sm on-media', type: 'button', 'aria-label': 'Masquer', onclick: () => ((dismissed = `src:${slowKey}`), renderHealth()) }, icon('close', 'icon icon-sm')),
      ];
    } else if (poorSince && now - poorSince > POOR_NOTICE_MS && dismissed !== slowKey) {
      // Not on Auto (which lowers the quality by itself): offer the next quality down.
      const manual = player.preference !== 'auto' && lower;
      key = `slow:${slowKey}:${manual ? lower : ''}`;
      content = [
        h('span', { class: 'notice-dot' }),
        'Connexion lente : risque de coupure.',
        manual
          ? h(
              'button',
              { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => ((poorSince = 0), player.setPreference(lower!), toast(`Qualité : ${label(lower!)}`)) },
              `Passer en ${label(lower!)}`
            )
          : null,
        h('button', { class: 'btn btn-ghost btn-icon btn-icon-sm on-media', type: 'button', 'aria-label': 'Masquer', onclick: () => ((dismissed = slowKey), renderHealth()) }, icon('close', 'icon icon-sm')),
      ];
    } else if (player.catchingUp && s?.running && !s.waiting.length) {
      key = 'catchup';
      content = [h('span', { class: 'spinner' }), 'Rattrapage de la salle…'];
    }
    if (key !== noticeKey) {
      noticeKey = key;
      clear(notice, content);
      notice.hidden = !key;
      notice.classList.toggle('notice-warn', key.startsWith('slow'));
    }
  }
  healthBtn.addEventListener('click', () => toast(healthBtn.title));

  // ------------------------------------------------------------ periodic: clock, seek bar, buffer
  const DRIFT_SHOWN_S = 1;
  function tick() {
    const s = state();
    const d = s?.media?.duration || 0;
    const room = s?.media ? player.expected() : 0;
    const local = s?.media ? player.localPosition() : 0;
    // This viewer's own picture: when it is behind/ahead of the room, show where *we*
    // are, with a marker where the room is.
    const drift = !!s?.media && video.readyState >= 1 && Math.abs(local - room) > DRIFT_SHOWN_S;
    const shown = drift ? local : room;
    if (!scrubbing) timeCur.textContent = formatTime(shown);
    timeDur.textContent = durationLabel(shown, d, remaining);
    if (!scrubbing && d) {
      seek.value = String(Math.round((shown / d) * 1000));
      seek.style.setProperty('--fill', `${((shown / d) * 100).toFixed(2)}%`);
    }
    if (d) {
      let buffered = 0;
      const t = video.currentTime;
      for (const [a, b] of player.bufferedRanges()) if (t >= a - 0.5 && t <= b) buffered = b;
      seek.style.setProperty('--buffered', `${((Math.max(buffered, shown) / d) * 100).toFixed(2)}%`);
    }
    ghost.hidden = !drift || !d;
    if (drift && d) ghost.style.left = `calc(${thumb / 2}px + (100% - ${thumb}px) * ${(room / d).toFixed(4)})`;
    seek.classList.toggle('drifting', drift);
    renderOverlay();
    renderHealth();
  }
  setInterval(tick, 250);
  // External subtitles follow this viewer's own video time.
  setInterval(() => {
    if (!state()?.media) return;
    if (player.subtitleTrack >= 0 && !subs.selected) subs.show(fileTrackLines());
    else subs.render(video.currentTime);
  }, 100);

  player.onChange = () => {
    renderMenu();
    overlayKey = '\u0000';
    renderOverlay();
  };

  // ------------------------------------------------------------ room state
  let lastSid: string | null = null;
  let lastRev = -1;
  let before: { pos: number; at: number; running: boolean } | null = null;
  function update() {
    const s = state();
    const media = s?.media;
    const sid = media?.sid || null;
    if (sid !== lastSid) {
      lastSid = sid;
      speech.reset();
      subs.load(sid, { videoId: media?.meta?.videoId, fps: media?.source?.fps });
      quietUntil = Date.now() + 10_000;
      dismissed = '';
      disarmStop();
    } else if (s && before && s.rev !== lastRev) {
      // Someone moved the room: the buffer refills, don't call it a slow connection.
      const predicted = before.pos + (before.running ? (Date.now() - before.at) / 1000 : 0);
      if (Math.abs(player.expected() - predicted) > 2) quietUntil = Date.now() + 8000;
    }
    if (s) {
      lastRev = s.rev;
      before = { pos: player.expected(), at: Date.now(), running: s.running };
    }
    const chips = memberChips(s, me.uid, label, host.memberClass);
    clear(stageMembers, chips.length > MAX_CHIPS ? [...chips.slice(0, MAX_CHIPS - 1), h('span', { class: 'member member-more' }, `+${chips.length - MAX_CHIPS + 1}`)] : chips);
    stageWho.textContent = watchersLabel(s?.members || [], me.uid);
    // Protected rooms: only the host and co-pilotes may stop for everyone.
    if (host.canStop) stopBtn.hidden = !host.canStop();
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
    setIcon(playBtn, playing ? 'pause' : 'play');
    setIcon(miniPlay, playing ? 'pause' : 'play');
    renderMenu();
    overlayKey = '\u0000';
    renderOverlay();
    if (s?.paused) wake();
  }

  function setMode(next: StageMode) {
    const s = state();
    for (const m of ['full', 'mini', 'hidden']) el.classList.toggle(`mode-${m}`, m === next);
    el.classList.toggle('has-media', !!s?.media);
    document.body.classList.toggle('player-open', next === 'full');
    if (next !== mode) {
      if (next !== 'full') {
        closeMenus();
        if (fsElement() === el) toggleFullscreen();
      }
      mode = next;
    }
    if (next === 'full') wake();
  }

  renderVolume();
  return { el, update, setMode, label };
}
