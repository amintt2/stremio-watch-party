// Room sheet ("Salle"): control mode, members and their state, host-mode requests and
// votes, and the suggestion queue with 👍 votes. Side sheet on desktop, bottom sheet on
// phones (see the "room / social" section of style.css). Opened from room.ts.

import { img, type Member, type QueueItem, type RoomState, type User } from '../api.ts';
import type { Connection } from '../connection.ts';
import { clear, h, toast } from '../dom.ts';
import { canStart, isIdle, majorityNeeded, memberStateLabel, parseTime, presentVotes } from '../social.ts';
import { formatTime } from '../sync.ts';
import { avatar, icon } from '../ui.ts';

type Send = Connection['send'];

export interface QueueContext {
  me: User;
  send: Send;
  /** Server time (ms). */
  now: () => number;
  close: () => void;
}

// Icons of the social layer (24×24, stroke = currentColor).
const ICONS: Record<string, string> = {
  queue: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="m16 15 5 3-5 3z" fill="currentColor"/>',
  crown: '<path d="M4 18h16l1-10-5 4-4-7-4 7-5-4z" fill="currentColor" stroke-linejoin="round"/>',
  thumb: '<path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/>',
};

export function roomIcon(name: string, cls = 'icon') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

/** Avatar with the host crown. */
export function memberAvatar(m: Member, host: boolean) {
  return h('span', { class: `room-avatar${host ? ' host' : ''}`, title: host ? `${m.name} · hôte` : m.name }, avatar(m), host ? roomIcon('crown', 'icon room-crown') : null);
}

const code = (item: Pick<QueueItem, 'subtitle'>) => item.subtitle.split(' · ')[0];

export function queuePanel(ctx: QueueContext) {
  const { me, send } = ctx;
  const body = h('div', { class: 'room-sheet-body' });
  // Kept across renders so typing isn't lost when the state changes.
  const seekInput = h('input', { class: 'input input-sm room-seek-input', type: 'text', inputmode: 'numeric', placeholder: '42:10', 'aria-label': 'Position demandée' });
  const el = h(
    'div',
    { class: 'room-sheet-inner' },
    h(
      'header',
      { class: 'room-sheet-head' },
      h('h2', {}, 'Salle'),
      h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Fermer', onclick: () => ctx.close() }, icon('close'))
    ),
    body
  );


  const section = (title: string, ...children: (Node | string | null | false)[]) =>
    h('section', { class: 'room-section' }, h('h3', { class: 'room-section-title' }, title), ...children);

  function controlSection(s: RoomState) {
    const mode = s.control || 'all';
    const isHost = s.host === me.uid;
    const host = s.members.find((m) => m.uid === s.host);
    const choice = (value: 'all' | 'host', label: string) =>
      h(
        'button',
        {
          type: 'button',
          class: mode === value ? 'active' : '',
          'aria-pressed': mode === value ? 'true' : 'false',
          // Anyone may give the control to the host; only the host may give it back.
          disabled: mode !== value && value === 'all' && !isHost,
          onclick: () => mode !== value && send({ t: 'mode', value }),
        },
        label
      );
    const hint =
      mode === 'all'
        ? 'Chacun peut mettre en pause, avancer ou lancer.'
        : isHost
          ? 'Tu es l’hôte : les autres te demandent une pause ou un déplacement, ou votent.'
          : `${host?.name || 'L’hôte'} contrôle la lecture. Demande-lui, ou votez à la majorité.`;
    return section(
      'Contrôle',
      h('div', { class: 'segmented segmented-wide', role: 'group', 'aria-label': 'Qui contrôle' }, choice('all', 'Tout le monde contrôle'), choice('host', 'Seul l’hôte contrôle')),
      h('p', { class: 'room-hint' }, hint),
      mode === 'host' && s.media && !isHost ? askActions(s) : null
    );
  }

  function askActions(s: RoomState) {
    const n = s.members.length;
    const need = majorityNeeded(n);
    const vote = (kind: 'pause' | 'skip') => s.votes?.find((v) => v.kind === kind);
    const voteBtn = (kind: 'pause' | 'skip', label: string) => {
      const v = vote(kind);
      const mine = !!v?.voters.includes(me.uid);
      const count = v ? presentVotes(v.voters, s.members) : 0;
      return h(
        'button',
        {
          class: `btn btn-sm${mine ? ' btn-primary' : ''}`,
          type: 'button',
          'aria-pressed': mine ? 'true' : 'false',
          disabled: kind === 'pause' && s.paused && !v,
          onclick: () => send({ t: 'voteAction', kind }),
        },
        roomIcon('thumb', 'icon icon-sm'),
        `${label} (${count}/${need})`
      );
    };
    const seekBtn = h(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => {
          const pos = parseTime(seekInput.value);
          if (pos === null) return toast('Position invalide (ex. 42:10)');
          send({ t: 'request', kind: 'seek', position: pos });
          seekInput.value = '';
        },
      },
      'Demander'
    );
    return h(
      'div',
      { class: 'room-ask' },
      h(
        'div',
        { class: 'room-ask-row' },
        h(
          'button',
          { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => send({ t: 'request', kind: s.paused ? 'play' : 'pause' }) },
          s.paused ? 'Demander de reprendre' : 'Demander une pause'
        ),
        h('span', { class: 'room-ask-seek' }, h('span', { class: 'muted small' }, 'Aller à'), seekInput, seekBtn)
      ),
      h('div', { class: 'room-ask-row' }, voteBtn('pause', 'Voter pause'), voteBtn('skip', 'Voter pour passer'))
    );
  }

  function membersSection(s: RoomState) {
    const hostMode = s.control === 'host';
    const iAmHost = s.host === me.uid;
    const rows = [...s.members]
      .sort((a, b) => Number(b.uid === s.host) - Number(a.uid === s.host))
      .map((m) =>
        h(
          'li',
          { class: `room-member state-${m.state || 'watching'}` },
          memberAvatar(m, hostMode && m.uid === s.host),
          h(
            'span',
            { class: 'room-member-text' },
            h('span', { class: 'room-member-name' }, m.name, m.uid === me.uid ? h('span', { class: 'faint' }, ' (toi)') : null, hostMode && m.uid === s.host ? h('span', { class: 'room-tag' }, 'hôte') : null),
            h('span', { class: 'room-member-state' }, h('span', { class: 'room-dot' }), s.media ? memberStateLabel(m) : 'dans la salle')
          ),
          hostMode && iAmHost && m.uid !== me.uid
            ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: `Donner le contrôle à ${m.name}`, onclick: () => send({ t: 'host', uid: m.uid }) }, 'Passer l’hôte')
            : null
        )
      );
    return section(`Dans la salle (${s.members.length})`, h('ul', { class: 'room-members' }, rows));
  }

  function queueSection(s: RoomState) {
    const queue = s.queue || [];
    const n = s.members.length;
    const need = majorityNeeded(n);
    const idle = isIdle(s);
    const allowed = canStart(s, me.uid);
    const items = queue.map((item, i) => {
      const votes = presentVotes(item.votes, s.members);
      const mine = item.votes.includes(me.uid);
      const top = i === 0;
      const countdown = s.autostart?.itemId === item.id;
      return h(
        'li',
        { class: `room-item${top ? ' top' : ''}${countdown ? ' armed' : ''}` },
        h('span', { class: 'room-item-poster' }, item.poster ? h('img', { src: img(item.poster), alt: '', loading: 'lazy', onerror: (e: Event) => (e.currentTarget as HTMLElement).remove() }) : null),
        h(
          'span',
          { class: 'room-item-text' },
          h('span', { class: 'room-item-title' }, item.title, item.subtitle ? h('span', { class: 'faint' }, ` · ${code(item)}`) : null),
          h('span', { class: 'room-item-sub' }, `Proposé par ${item.uid === me.uid ? 'toi' : item.name}`, ' · ', item.source || 'meilleure source au lancement'),
          top && idle ? h('span', { class: 'room-item-sub room-item-need' }, `${votes}/${need} pour lancer automatiquement`) : null
        ),
        h(
          'span',
          { class: 'room-item-actions' },
          h(
            'button',
            {
              class: `btn btn-sm room-vote${mine ? ' voted' : ''}`,
              type: 'button',
              'aria-pressed': mine ? 'true' : 'false',
              title: mine ? 'Retirer mon vote' : 'Voter pour',
              onclick: () => send({ t: 'vote', id: item.id }),
            },
            roomIcon('thumb', 'icon icon-sm'),
            String(item.votes.length)
          ),
          allowed
            ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', title: 'Lancer pour tout le monde', onclick: () => send({ t: 'start', id: item.id }) }, icon('play', 'icon icon-sm'), 'Lancer')
            : null,
          item.uid === me.uid || (s.control === 'host' && s.host === me.uid)
            ? h('button', { class: 'btn btn-ghost btn-icon btn-icon-sm', type: 'button', title: 'Retirer la proposition', 'aria-label': 'Retirer', onclick: () => send({ t: 'withdraw', id: item.id }) }, icon('trash', 'icon icon-sm'))
            : null
        )
      );
    });
    return section(
      `File d’attente (${queue.length})`,
      h(
        'p',
        { class: 'room-hint' },
        'Lancer quand la majorité est d’accord : la proposition en tête démarre toute seule quand plus de la moitié de la salle a voté pour, une fois la vidéo en cours terminée.'
      ),
      queue.length
        ? h('ol', { class: 'room-queue' }, items)
        : h('p', { class: 'room-empty' }, 'Rien en attente. Sur une fiche, clique ', h('strong', {}, 'Proposer'), ' pour ajouter un film ou un épisode.')
    );
  }

  function nowPlaying(s: RoomState) {
    if (!s.media) return null;
    return h(
      'div',
      { class: 'room-now' },
      s.media.poster ? h('img', { class: 'room-now-poster', src: img(s.media.poster), alt: '' }) : null,
      h(
        'span',
        { class: 'room-item-text' },
        h('span', { class: 'room-item-sub' }, s.ended ? 'Terminé' : s.paused ? 'En pause' : 'En cours'),
        h('span', { class: 'room-item-title' }, s.media.title, s.media.subtitle ? h('span', { class: 'faint' }, ` · ${code(s.media)}`) : null),
        h('span', { class: 'room-item-sub' }, `Lancé par ${s.media.startedBy}${s.media.duration ? ` · ${formatTime(s.media.duration)}` : ''}`)
      )
    );
  }

  function render(s: RoomState | null) {

    if (!s) return clear(body, h('p', { class: 'room-empty' }, h('span', { class: 'spinner' }), 'Connexion à la salle…'));
    const focused = document.activeElement === seekInput;
    clear(body, nowPlaying(s), controlSection(s), queueSection(s), membersSection(s));
    if (focused) seekInput.focus();
  }

  return { el, render };
}
