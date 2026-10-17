// "Ouvrir dans…" (VLC, Infuse, MX Player...) and "Ouvrir sur le site", in the player.
//
// Going external detaches this page's player: it stops playing, tells the room not to
// wait for this viewer (member flag "external") and becomes a remote: the stage's
// play/pause/seek still drive the room, and a panel shows the room's time to "Recaler"
// the external player, which doesn't follow the room on its own.
import { api, type RoomState, type User } from './api.ts';
import { continueInBrowser } from './auth.ts';
import type { Connection } from './connection.ts';
import { clear, h, toast } from './dom.ts';
import {
  detectPlatform,
  externalOptions,
  m3uPlaylist,
  nativeHref,
  playlistName,
  type ExternalFile,
  type ExternalOption,
} from './external.ts';
import type { Player } from './player.ts';
import { formatTime } from './sync.ts';
import { copyText, icon } from './ui.ts';

export interface ExternalHost {
  me: User;
  conn: Connection;
  player: Player;
  state(): RoomState | null;
  /** Inside the Discord Activity: native app links can't be opened from there. */
  inDiscord: boolean;
}

type Mode = 'off' | 'external' | 'site';

interface FileInfo extends ExternalFile {
  sid: string;
}

export function createExternal(host: ExternalHost) {
  const { conn, player } = host;
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints || 0);
  const options = externalOptions(platform, host.inDiscord);
  let mode: Mode = 'off';
  /** The option used last ("Recaler" reopens it at the room's time when it can). */
  let last: ExternalOption | null = null;
  let file: FileInfo | null = null;
  let fetching: Promise<FileInfo | null> | null = null;
  let stage: HTMLElement | null = null;
  let flagSent = { value: false, at: 0 };

  const triggerLabel = 'Ouvrir dans un autre lecteur';
  const topButton = h(
    'button',
    { class: 'btn btn-ghost btn-icon on-media ext-open', type: 'button', 'aria-label': triggerLabel, title: triggerLabel, 'aria-haspopup': 'dialog' },
    icon('external')
  );
  const panel = h('div', { class: 'stage-menu ext-menu', role: 'dialog', 'aria-label': 'Ouvrir dans…', hidden: true });
  const remoteTime = h('strong', { class: 'ext-time' });
  const remoteState = h('span', { class: 'muted-on-media' });
  const remoteTitle = h('strong', {});
  const remote = h(
    'div',
    { class: 'ext-remote', hidden: true, role: 'region', 'aria-label': 'Lecteur externe' },
    h('div', { class: 'ext-remote-head' }, icon('external'), remoteTitle),
    h('div', { class: 'ext-remote-clock' }, h('span', { class: 'muted-on-media' }, 'Salle'), remoteTime, remoteState),
    h('p', { class: 'ext-hint' }, 'Ton lecteur ne suit pas les pauses et les sauts de la salle. «\u00a0Recaler\u00a0» te donne l’endroit où en est la salle.'),
    h(
      'div',
      { class: 'ext-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => resync() }, icon('reset', 'icon icon-sm'), 'Recaler'),
      h('button', { class: 'btn btn-ghost btn-sm on-media ext-outline', type: 'button', onclick: () => open() }, 'Ouvrir dans…'),
      h('button', { class: 'btn btn-ghost btn-sm on-media', type: 'button', onclick: () => setMode('off') }, 'Revenir au lecteur intégré')
    )
  );

  const sid = () => host.state()?.media?.sid || null;
  const roomPosition = () => (host.state()?.media ? player.expected() : 0);

  /** The private file link of the current media (12 h), fetched once per media. */
  function fetchFile(): Promise<FileInfo | null> {
    const current = sid();
    if (!current) return Promise.resolve(null);
    if (file?.sid === current) return Promise.resolve(file);
    if (fetching) return fetching;
    fetching = api<ExternalFile>(`/api/media/${encodeURIComponent(current)}/external`, { method: 'POST' })
      .then((res) => {
        if (sid() !== current) return null;
        file = { ...res, sid: current };
        render();
        return file;
      })
      .catch((err: Error) => {
        toast(err.message);
        return null;
      })
      .finally(() => (fetching = null));
    return fetching;
  }

  // ------------------------------------------------------------ mode

  function setMode(next: Mode) {
    if (next === mode) return;
    mode = next;
    player.setDetached(next !== 'off');
    // The site plays for this same account: only a real external player drops out of the waits.
    sendFlag(next === 'external');
    if (next === 'off') toast('Retour au lecteur intégré');
    render();
  }

  function sendFlag(value: boolean) {
    flagSent = { value, at: Date.now() };
    conn.send({ t: 'external', value });
  }

  // ------------------------------------------------------------ actions

  function launch(option: ExternalOption, f: FileInfo) {
    const at = { ...f, position: roomPosition() };
    const href = nativeHref(option.id, platform, at);
    if (href) {
      location.href = href;
      return true;
    }
    if (option.id === 'm3u') {
      const blob = new Blob([m3uPlaylist(at)], { type: 'audio/x-mpegurl' });
      const a = h('a', { href: URL.createObjectURL(blob), download: playlistName(f.title || f.name) });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      toast('Playlist téléchargée : ouvre-la avec VLC');
      return true;
    }
    if (option.id === 'copy') {
      void copyText(f.url, 'Lien copié : colle-le dans ton lecteur (Ouvrir un flux réseau)');
      return true;
    }
    return false;
  }

  async function choose(option: ExternalOption) {
    if (option.id === 'site') {
      close();
      try {
        await continueInBrowser();
        // The site page takes over for this account; this one stops playing.
        last = option;
        setMode('site');
      } catch (err) {
        toast((err as Error).message);
      }
      return;
    }
    if (host.inDiscord && option.native) return;
    // Opened synchronously when the link is ready (iOS needs the tap's activation).
    const f = file?.sid === sid() ? file : await fetchFile();
    if (!f) return;
    if (!launch(option, f)) return;
    last = option;
    close();
    setMode('external');
  }

  function resync() {
    const pos = roomPosition();
    const f = file?.sid === sid() ? file : null;
    // Players that take a start time are simply reopened there.
    if (mode === 'external' && last?.startsAt && f && launch(last, f)) return;
    toast(`La salle est à ${formatTime(pos)} : va à ce moment dans ton lecteur`);
  }

  // ------------------------------------------------------------ panel

  function open() {
    if (!sid()) return;
    panel.hidden = false;
    stage?.classList.add('menu-open');
    void fetchFile();
    render();
    (panel.querySelector('button:not([disabled])') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function close() {
    if (panel.hidden) return false;
    panel.hidden = true;
    if (stage && stage.querySelectorAll('.stage-menu:not([hidden])').length === 0) stage.classList.remove('menu-open');
    return true;
  }

  const optionButton = (o: ExternalOption) => {
    const blocked = host.inDiscord && o.native;
    return h(
      'button',
      { class: `menu-row ext-option${o.id === 'site' ? ' ext-primary' : ''}`, type: 'button', disabled: blocked, onclick: () => void choose(o) },
      icon(o.id === 'copy' ? 'link' : o.id === 'm3u' ? 'download' : 'external', 'icon icon-sm'),
      h('span', { class: 'ext-option-text' }, h('span', { class: 'menu-row-title' }, o.label), o.hint ? h('span', { class: 'menu-row-value' }, o.hint) : null),
      o.startsAt && !blocked ? h('span', { class: 'ext-badge' }, 'reprend au bon moment') : null
    );
  };

  let panelKey = '';
  function render() {
    const media = host.state()?.media;
    // Room updates are frequent: rebuild the list only when what it shows changed.
    const key = panel.hidden ? '' : JSON.stringify([media?.sid, !!file, !!fetching]);
    if (key && key !== panelKey) {
      const natives = options.filter((o) => o.native);
      const others = options.filter((o) => !o.native);
      clear(
        panel,
        h(
          'div',
          { class: 'menu-head' },
          h('strong', {}, 'Ouvrir dans…'),
          h('button', { class: 'btn btn-ghost btn-icon on-media', type: 'button', 'aria-label': 'Fermer', onclick: () => close() }, icon('close'))
        ),
        h('p', { class: 'ext-intro' }, 'Le fichier d’origine, dans ton lecteur : toutes les pistes audio, les sous-titres intégrés, sans conversion.'),
        others.filter((o) => o.id === 'site').map(optionButton),
        host.inDiscord ? h('div', { class: 'menu-group' }, 'Applications (depuis le site)') : natives.length ? h('div', { class: 'menu-group' }, 'Applications') : null,
        host.inDiscord ? h('p', { class: 'ext-note' }, 'Discord ne peut pas ouvrir d’autres applis : passe par «\u00a0Ouvrir sur le site\u00a0», puis «\u00a0Ouvrir dans…\u00a0» dans ton navigateur.') : null,
        natives.map(optionButton),
        others.filter((o) => o.id !== 'site').map(optionButton),
        !file && fetching ? h('p', { class: 'ext-note' }, h('span', { class: 'spinner' }), 'Préparation du lien…') : null
      );
    }
    panelKey = key;
    const active = mode !== 'off' && !!media;
    remote.hidden = !active;
    stage?.classList.toggle('ext-active', active);
    topButton.classList.toggle('active', active);
    if (active) {
      remoteTitle.textContent =
        mode === 'site' ? 'La lecture continue dans ton navigateur' : `Lecture dans ${last && last.id !== 'copy' && last.id !== 'chooser' ? last.label.replace(/^Ouvrir dans /, '') : 'ton lecteur'}`;
      tick();
    }
  }

  function tick() {
    if (remote.hidden) return;
    const s = host.state();
    const d = s?.media?.duration;
    remoteTime.textContent = `${formatTime(roomPosition())}${d ? ` / ${formatTime(d)}` : ''}`;
    remoteState.textContent = !s?.media ? '' : s.waiting.length ? 'chargement…' : s.paused ? 'en pause' : 'en lecture';
  }
  setInterval(tick, 500);

  topButton.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!panel.hidden && !panel.contains(t) && !topButton.contains(t) && !(t as HTMLElement).closest?.('.ext-trigger')) close();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && close()) e.stopImmediatePropagation();
    },
    true
  );

  let lastSid: string | null = null;
  return {
    topButton,
    /** Row for the player's settings menu. */
    menuRow(closeMenu: () => void) {
      return h(
        'button',
        { class: 'menu-row ext-trigger', type: 'button', onclick: () => (closeMenu(), open()) },
        icon('external', 'icon icon-sm'),
        h('span', { class: 'menu-row-title' }, host.inDiscord ? 'Ouvrir sur le site / dans…' : 'Ouvrir dans…'),
        icon('chevron', 'icon icon-sm')
      );
    },
    /** Puts the panel and the remote into the stage. */
    mount(el: HTMLElement) {
      stage = el;
      el.append(remote, panel);
    },
    /** Room state changed. */
    update() {
      const s = host.state();
      const current = s?.media?.sid || null;
      if (current !== lastSid) {
        lastSid = current;
        file = null;
        if (!current) {
          close();
          if (mode !== 'off') {
            mode = 'off';
            player.setDetached(false);
          }
        }
      }
      // After a reconnect the server forgot the flag: say it again (not more than every 3 s).
      const mine = s?.members.find((m) => m.uid === host.me.uid);
      if (mode === 'external' && mine && !mine.external && Date.now() - flagSent.at > 3000) sendFlag(true);
      render();
    },
  };
}
