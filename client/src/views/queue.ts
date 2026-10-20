// Room sheet ("Salle"): now playing, control mode, requests and votes for viewers,
// the suggestion queue with 👍 votes, the waiting room and the members with their
// role and state (host actions: co-pilote, passer l’hôte, exclure). Side sheet on
// desktop, bottom sheet on phones (see the "room / social" section of style.css).
// The server decides everything; buttons only appear when the server would accept.

import { img, type Member, type QueueItem, type RoomState, type User } from '../api.ts';
import type { Connection } from '../connection.ts';
import { clear, h, toast } from '../dom.ts';
import { canControl, isIdle, isModerator, memberStateLabel, parseTime, presentVotes, roleLabel, votesNeeded } from '../social.ts';
import { formatTime } from '../sync.ts';
import { avatar, icon } from '../ui.ts';

type Send = Connection['send'];

export interface QueueContext {
  me: User;
  send: Send;
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
export function memberAvatar(m: Pick<Member, 'name' | 'avatar'>, host: boolean) {
  return h('span', { class: `room-avatar${host ? ' host' : ''}`, title: host ? `${m.name} · hôte` : m.name }, avatar(m), host ? roomIcon('crown', 'icon room-crown') : null);
}

const code = (item: Pick<QueueItem, 'subtitle'>) => item.subtitle.split(' · ')[0];

export function queuePanel(ctx: QueueContext) {
  const { me, send } = ctx;
  const body = h('div', { class: 'room-sheet-body' });
  // Kept across renders so typing isn't lost when the state changes.
  const seekInput = h('input', { class: 'input input-sm room-seek-input', type: 'text', inputmode: 'numeric', placeholder: '42:10', 'aria-label': 'Position demandée' });
  /** Two-step confirm for "Exclure" (no confirm() inside the Discord iframe). */
  let kickArmed: { uid: string; at: number } | null = null;
  let last: RoomState | null = null;

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
    const mode = s.control || 'host';
    const isHost = s.host === me.uid;
    const host = s.members.find((m) => m.uid === s.host);
    const choice = (value: 'all' | 'host', label: string) =>
      h(
        'button',
        {
          type: 'button',
          class: mode === value ? 'active' : '',
          'aria-pressed': mode === value ? 'true' : 'false',
          disabled: !isHost && mode !== value,
          title: isHost ? undefined : 'Seul l’hôte change ce réglage',
          onclick: () => isHost && mode !== value && send({ t: 'mode', value }),
        },
        label
      );
    const hint =
      mode === 'all'
        ? 'Tout le monde peut mettre en pause, avancer ou lancer.'
        : isHost
          ? 'Tu es l’hôte : toi et les co-pilotes contrôlez. Les autres te demandent, ou votent à la majorité.'
          : isModerator(s, me.uid)
            ? 'Tu es co-pilote : tu contrôles la lecture et réponds aux demandes.'
            : `${host?.name || 'L’hôte'} et les co-pilotes contrôlent. Demande-leur, ou votez à la majorité.`;
    return section(
      'Contrôle',
      h('div', { class: 'segmented segmented-wide', role: 'group', 'aria-label': 'Qui contrôle' }, choice('host', 'Hôte et co-pilotes'), choice('all', 'Tout le monde')),
      h('p', { class: 'room-hint' }, hint),
      s.media && !canControl(s, me.uid) ? askActions(s) : null
    );
  }

  function askActions(s: RoomState) {
    const need = votesNeeded(s.members.length);
    const muted = !!s.muted?.includes(me.uid);
    const voteBtn = (kind: 'pause' | 'skip', label: string) => {
      const v = s.votes?.find((x) => x.kind === kind);
      const mine = !!v?.voters.includes(me.uid);
      const count = v ? presentVotes(v.voters, s.members) : 0;
      return h(
        'button',
        {
          class: `btn btn-sm${mine ? ' btn-primary' : ''}`,
          type: 'button',
          'aria-pressed': mine ? 'true' : 'false',
          disabled: muted || (kind === 'pause' && s.paused && !v),
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
        disabled: muted,
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
      muted ? h('p', { class: 'room-hint auth-error' }, 'Trop d’actions : tes demandes sont ignorées quelques secondes.') : null,
      h(
        'div',
        { class: 'room-ask-row' },
        h(
          'button',
          { class: 'btn btn-sm btn-secondary', type: 'button', disabled: muted, onclick: () => send({ t: 'request', kind: s.paused ? 'play' : 'pause' }) },
          s.paused ? 'Demander de reprendre' : 'Demander une pause'
        ),
        h('span', { class: 'room-ask-seek' }, h('span', { class: 'muted small' }, 'Aller à'), seekInput, seekBtn)
      ),
      h('div', { class: 'room-ask-row' }, voteBtn('pause', 'Voter pause'), voteBtn('skip', 'Voter pour passer'))
    );
  }

  function waitingSection(s: RoomState) {
    if (!s.lobby || !isModerator(s, me.uid)) return null;
    const pending = s.pending || [];
    const auto = h('label', { class: 'room-switch' }, h('input', { type: 'checkbox', checked: !!s.autoAdmit, onchange: (e: Event) => send({ t: 'autoAdmit', value: (e.currentTarget as HTMLInputElement).checked }) }), 'Accepter tout le monde automatiquement');
    return section(
      `En attente (${pending.length})`,
      pending.length
        ? h(
            'ul',
            { class: 'room-members' },
            pending.map((p) =>
              h(
                'li',
                { class: 'room-member' },
                memberAvatar(p, false),
                h('span', { class: 'room-member-text' }, h('span', { class: 'room-member-name' }, p.name), h('span', { class: 'room-member-state' }, 'veut entrer')),
                h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => send({ t: 'admit', uid: p.uid }) }, 'Faire entrer'),
                h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => send({ t: 'refuse', uid: p.uid }) }, 'Refuser')
              )
            )
          )
        : h('p', { class: 'room-hint' }, 'Personne n’attend. Les nouveaux venus du lien de la salle arrivent ici.'),
      auto
    );
  }

  function membersSection(s: RoomState) {
    const iAmHost = s.host === me.uid;
    const rank = (m: Member) => (m.uid === s.host ? 0 : s.copilots?.includes(m.uid) ? 1 : 2);
    const rows = [...s.members]
      .sort((a, b) => rank(a) - rank(b))
      .map((m) => {
        const role = roleLabel(s, m.uid);
        const isCopilot = !!s.copilots?.includes(m.uid);
        const armed = kickArmed?.uid === m.uid && Date.now() - kickArmed.at < 3000;
        const tools =
          iAmHost && m.uid !== me.uid
            ? h(
                'span',
                { class: 'room-member-tools' },
                h(
                  'button',
                  { class: `btn btn-ghost btn-sm${isCopilot ? ' active' : ''}`, type: 'button', 'aria-pressed': isCopilot ? 'true' : 'false', title: isCopilot ? 'Retirer co-pilote' : 'Nommer co-pilote : contrôle la lecture et répond aux demandes', onclick: () => send({ t: 'copilot', uid: m.uid, value: !isCopilot }) },
                  isCopilot ? 'Co-pilote ✓' : 'Co-pilote'
                ),
                h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: `Donner la couronne à ${m.name}`, onclick: () => send({ t: 'host', uid: m.uid }) }, 'Hôte'),
                h(
                  'button',
                  {
                    class: `btn btn-ghost btn-sm room-kick${armed ? ' armed' : ''}`,
                    type: 'button',
                    title: `Exclure ${m.name} de la salle`,
                    onclick: () => {
                      if (armed) {
                        kickArmed = null;
                        send({ t: 'kick', uid: m.uid });
                      } else {
                        kickArmed = { uid: m.uid, at: Date.now() };
                        render(last);
                        setTimeout(() => render(last), 3100);
                      }
                    },
                  },
                  armed ? 'Confirmer ?' : 'Exclure'
                )
              )
            : null;
        return h(
          'li',
          { class: `room-member state-${m.state || 'watching'}` },
          memberAvatar(m, m.uid === s.host),
          h(
            'span',
            { class: 'room-member-text' },
            h(
              'span',
              { class: 'room-member-name' },
              m.name,
              m.uid === me.uid ? h('span', { class: 'faint' }, ' (toi)') : null,
              role ? h('span', { class: `room-tag${role === 'hôte' ? '' : ' room-tag-copilot'}` }, role) : null
            ),
            h('span', { class: 'room-member-state' }, h('span', { class: 'room-dot' }), s.media ? memberStateLabel(m) : 'dans la salle', s.muted?.includes(m.uid) ? ' · trop d’actions' : '')
          ),
          tools
        );
      });
    return section(`Dans la salle (${s.members.length})`, h('ul', { class: 'room-members' }, rows));
  }

  function queueSection(s: RoomState) {
    const queue = s.queue || [];
    const need = votesNeeded(s.members.length);
    const idle = isIdle(s);
    const allowed = canControl(s, me.uid);
    const asked = (id: string) => s.requests?.some((r) => r.uid === me.uid && r.kind === 'start' && r.itemId === id);
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
          top && idle ? h('span', { class: 'room-item-sub room-item-need' }, `${votes}/${need} votes pour lancer automatiquement`) : null
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
            String(votes)
          ),
          allowed
            ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', title: 'Lancer pour tout le monde', onclick: () => send({ t: 'start', id: item.id }) }, icon('play', 'icon icon-sm'), 'Lancer')
            : h(
                'button',
                { class: 'btn btn-sm', type: 'button', disabled: asked(item.id), title: 'Demander à l’hôte de le lancer', onclick: () => send({ t: 'request', kind: 'start', id: item.id }) },
                asked(item.id) ? 'Demandé' : 'Demander'
              ),
          item.uid === me.uid || isModerator(s, me.uid)
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
        'Lancer quand la majorité est d’accord : une fois la vidéo terminée, la proposition en tête démarre toute seule si plus de la moitié de la salle (2 personnes minimum) a voté pour.'
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
        h('span', { class: 'room-item-sub' }, (s.done ?? s.ended) ? 'Terminé' : s.paused ? 'En pause' : 'En cours'),
        h('span', { class: 'room-item-title' }, s.media.title, s.media.subtitle ? h('span', { class: 'faint' }, ` · ${code(s.media)}`) : null),
        h('span', { class: 'room-item-sub' }, `Lancé par ${s.media.startedBy}${s.media.duration ? ` · ${formatTime(s.media.duration)}` : ''}`)
      )
    );
  }

  function render(s: RoomState | null) {
    last = s;
    if (!s) return clear(body, h('p', { class: 'room-empty' }, h('span', { class: 'spinner' }), 'Connexion à la salle…'));
    const focused = document.activeElement === seekInput;
    clear(body, nowPlaying(s), controlSection(s), waitingSection(s), queueSection(s), membersSection(s));
    if (focused) seekInput.focus();
  }

  return { el, render };
}
