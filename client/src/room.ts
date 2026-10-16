// Social layer of the room, on top of the shell (main.ts keeps only a few hooks):
// - a "Salle" button (top bar + player) opening the room sheet (views/queue.ts):
//   control mode, members with their state, suggestions and votes;
// - a dock of live cards visible everywhere: countdowns (vote, next episode), what is
//   starting, requests and newcomers for the host/co-pilotes, votes to pause/skip;
// - the waiting-room and "exclu" screens;
// - this viewer's presence (watching / browsing) for the others;
// - proposing a title (detail page) and the host-mode fallback of "Regarder ensemble".
// Everything is decided by the server (server/src/rooms.js); this only shows and asks.

import { api, type Member, type RoomState, type User } from './api.ts';
import type { PlayRequest } from './app.ts';
import type { Connection } from './connection.ts';
import { clear, h } from './dom.ts';
import { canControl, canStart, isModerator, presentVotes, secondsLeft, votesNeeded } from './social.ts';
import { icon } from './ui.ts';
import { memberAvatar, queuePanel, roomIcon } from './views/queue.ts';

/** A suggestion: like PlayRequest, but the source is optional (best one at start). */
export type ProposeRequest = Omit<PlayRequest, 'streamKey' | 'startAt'> & { streamKey?: string };

export class RoomSocial {
  /** Top bar button. */
  readonly topButton: HTMLButtonElement;
  /** Button for the player's top bar. */
  readonly stageButton: HTMLButtonElement;
  /** Sheet + scrim + dock: appended once to the app root. */
  readonly el: HTMLElement;

  private state: RoomState | null = null;
  private readonly dock = h('div', { class: 'room-dock', 'aria-live': 'polite' });
  /** Full-screen notice: waiting room, kicked, refused. */
  private readonly gate = h('div', { class: 'room-gate', hidden: true, role: 'alertdialog', 'aria-live': 'assertive' });
  private readonly sheet: HTMLElement;
  private readonly scrim: HTMLElement;
  private readonly panel: ReturnType<typeof queuePanel>;
  private open = false;
  private presenceSent: { value: string; at: number } | null = null;

  constructor(
    private readonly me: User,
    private readonly conn: Connection
  ) {
    const count = () => h('span', { class: 'room-count', hidden: true });
    this.topButton = h(
      'button',
      { class: 'btn btn-ghost btn-sm room-open', type: 'button', title: 'Salle : propositions, votes, contrôle', 'aria-haspopup': 'dialog' },
      roomIcon('queue', 'icon icon-sm'),
      h('span', { class: 'btn-label' }, 'Salle'),
      count()
    );
    this.stageButton = h(
      'button',
      { class: 'btn btn-ghost btn-sm on-media room-open', type: 'button', title: 'Salle : propositions, votes, contrôle', 'aria-haspopup': 'dialog' },
      roomIcon('queue', 'icon icon-sm'),
      h('span', { class: 'btn-label' }, 'Salle'),
      count()
    );
    for (const b of [this.topButton, this.stageButton]) b.addEventListener('click', () => this.toggle(true));

    this.panel = queuePanel({
      me,
      send: (msg) => conn.send(msg),
      close: () => this.toggle(false),
    });
    this.scrim = h('div', { class: 'room-scrim', hidden: true, onclick: () => this.toggle(false) });
    this.sheet = h('aside', { class: 'room-sheet', role: 'dialog', 'aria-label': 'Salle', 'aria-modal': 'false' }, this.panel.el);
    this.el = h('div', { class: 'room-layer' }, this.dock, this.scrim, this.sheet, this.gate);
    conn.onLobby = (info) => this.showGate('lobby', info.host);
    conn.onKicked = (reason) => this.showGate(reason === 'refused' ? 'refused' : 'kicked');

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.open) {
        e.stopPropagation();
        this.toggle(false);
      }
    }, true);

    // Presence: the player is open (watching) or minimised (browsing the catalogue).
    new MutationObserver(() => this.syncPresence()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    setInterval(() => this.tickCountdowns(), 500);
  }

  toggle(open: boolean) {
    this.open = open;
    this.sheet.classList.toggle('open', open);
    this.scrim.hidden = !open;
    if (open) this.panel.render(this.state);
  }

  /** Waiting room / kicked / refused screen (the app stays usable under "lobby"). */
  private showGate(kind: 'lobby' | 'kicked' | 'refused', host: string | null = null) {
    const text = {
      lobby: ['Salle d’attente', `${host || 'L’hôte'} doit te faire entrer. Tu peux parcourir le catalogue en attendant.`],
      kicked: ['Tu as été exclu de la salle', 'L’hôte t’a retiré de cette salle. Tu peux en ouvrir une autre depuis Paramètres.'],
      refused: ['Entrée refusée', 'L’hôte n’a pas accepté ta demande. Réessaie plus tard.'],
    }[kind];
    this.gate.hidden = false;
    this.gate.className = `room-gate room-gate-${kind}`;
    clear(
      this.gate,
      h(
        'div',
        { class: 'room-gate-card' },
        kind === 'lobby' ? h('span', { class: 'spinner' }) : icon('close'),
        h('div', {}, h('strong', {}, text[0]), h('p', { class: 'muted' }, text[1])),
        kind === 'lobby' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => (this.gate.hidden = true) }, 'Masquer') : null
      )
    );
  }

  update(s: RoomState) {
    if (!this.state && this.gate.classList.contains('room-gate-lobby')) this.gate.hidden = true; // let in
    this.state = s;
    const n = s.queue?.length || 0;
    for (const b of [this.topButton, this.stageButton]) {
      const badge = b.querySelector<HTMLElement>('.room-count')!;
      badge.hidden = n === 0;
      badge.textContent = String(n);
      b.classList.toggle('has-items', n > 0);
    }
    if (this.open) this.panel.render(s);
    this.renderDock();
    this.syncPresence();
  }

  /** May this viewer start something for everyone right now? */
  canStart() {
    return canStart(this.state, this.me.uid);
  }

  /** Host crown on the avatar chips of the shell. */
  memberInfo(m: Member) {
    const host = this.state?.host === m.uid;
    return { host, cls: host ? ' host' : '' };
  }

  async propose(req: ProposeRequest) {
    const res = await api<{ duplicate: boolean }>('/api/room/propose', {
      method: 'POST',
      body: JSON.stringify({
        meta: { id: req.meta.id, type: req.meta.type, videoId: req.videoId },
        title: req.meta.name,
        subtitle: req.subtitle,
        poster: req.meta.poster,
        streamKey: req.streamKey,
      }),
    });
    return res;
  }

  private syncPresence() {
    const s = this.state;
    if (!s?.media) return;
    const value = document.body.classList.contains('player-open') ? 'watching' : 'browsing';
    const mine = s.members.find((m) => m.uid === this.me.uid);
    if (!mine || mine.state === 'loading' || mine.state === value) return;
    // Self-healing (after a reconnect the server forgets), without spamming.
    if (this.presenceSent?.value === value && Date.now() - this.presenceSent.at < 3000) return;
    this.presenceSent = { value, at: Date.now() };
    this.conn.send({ t: 'presence', value });
  }

  // ------------------------------------------------------------ dock (live cards)

  private card(cls: string, ...children: (Node | string | null | false)[]) {
    return h('div', { class: `room-card ${cls}` }, ...children);
  }

  private renderDock() {
    const s = this.state;
    if (!s) return clear(this.dock);
    const me = this.me.uid;
    const now = this.conn.clock.now();
    const cards: HTMLElement[] = [];

    if (s.starting) {
      cards.push(
        this.card(
          'room-card-info',
          h('span', { class: 'spinner' }),
          h('span', { class: 'room-card-text' }, `Lancement de « ${s.starting.title} »…`)
        )
      );
    }

    if (s.autostart) {
      const item = s.queue?.find((q) => q.id === s.autostart!.itemId);
      if (item) {
        cards.push(
          this.card(
            'room-card-countdown',
            h(
              'span',
              { class: 'room-card-text' },
              h('strong', {}, `« ${item.title}${item.subtitle ? ` · ${item.subtitle.split(' · ')[0]}` : ''} »`),
              h('span', { class: 'room-card-sub' }, 'La majorité a voté · démarre dans ', h('b', { 'data-at': s.autostart.at }, `${secondsLeft(s.autostart.at, now)} s`))
            ),
            canControl(s, me)
              ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.conn.send({ t: 'cancel', what: 'autostart' }) }, 'Annuler')
              : null
          )
        );
      }
    }

    if (s.autonext) {
      cards.push(
        this.card(
          'room-card-countdown',
          h(
            'span',
            { class: 'room-card-text' },
            h('strong', {}, 'Épisode suivant dans ', h('b', { 'data-at': s.autonext.at }, `${secondsLeft(s.autonext.at, now)} s`)),
            h('span', { class: 'room-card-sub' }, s.autonext.subtitle)
          ),
          canControl(s, me)
            ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.conn.send({ t: 'cancel', what: 'autonext' }) }, 'Annuler')
            : null
        )
      );
    }

    const moderator = isModerator(s, me);
    if (moderator) {
      for (const p of s.pending || []) {
        cards.push(
          this.card(
            'room-card-request',
            memberAvatar(p, false),
            h('span', { class: 'room-card-text' }, h('strong', {}, `${p.name} attend pour entrer`), h('span', { class: 'room-card-sub' }, 'Salle d’attente')),
            h(
              'span',
              { class: 'room-card-actions' },
              h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => this.conn.send({ t: 'admit', uid: p.uid }) }, 'Faire entrer'),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.conn.send({ t: 'refuse', uid: p.uid }) }, 'Refuser')
            )
          )
        );
      }
    }

    for (const r of s.requests || []) {
      const what = r.label;
      if (moderator) {
        cards.push(
          this.card(
            'room-card-request',
            h(
              'span',
              { class: 'room-card-text' },
              h('strong', {}, `${r.name} demande ${what}`),
              h('span', { class: 'room-card-sub' }, 'Expire dans ', h('b', { 'data-at': r.expires }, `${secondsLeft(r.expires, now)} s`))
            ),
            h(
              'span',
              { class: 'room-card-actions' },
              h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => this.conn.send({ t: 'respond', id: r.id, accept: true }) }, 'Accepter'),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.conn.send({ t: 'respond', id: r.id, accept: false }) }, 'Refuser')
            )
          )
        );
      } else if (r.uid === me) {
        cards.push(
          this.card(
            'room-card-info',
            h('span', { class: 'room-card-text' }, h('strong', {}, `Tu as demandé ${what}`), h('span', { class: 'room-card-sub' }, 'En attente de l’hôte ou d’un co-pilote · ', h('b', { 'data-at': r.expires }, `${secondsLeft(r.expires, now)} s`))),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => this.conn.send({ t: 'cancelRequest', id: r.id }) }, 'Retirer')
          )
        );
      }
    }

    for (const v of s.votes || []) {
      const count = presentVotes(v.voters, s.members);
      const mine = v.voters.includes(me);
      cards.push(
        this.card(
          'room-card-vote',
          h(
            'span',
            { class: 'room-card-text' },
            h('strong', {}, v.kind === 'pause' ? 'Vote : mettre en pause' : 'Vote : passer à la suite'),
            h('span', { class: 'room-card-sub' }, `${count}/${votesNeeded(s.members.length)} votes nécessaires`)
          ),
          h(
            'button',
            { class: `btn btn-sm${mine ? ' btn-primary' : ''}`, type: 'button', 'aria-pressed': mine ? 'true' : 'false', onclick: () => this.conn.send({ t: 'voteAction', kind: v.kind }) },
            roomIcon('thumb', 'icon icon-sm'),
            mine ? 'Voté' : 'Voter'
          )
        )
      );
    }
    clear(this.dock, cards);
  }

  /** Refreshes the "dans 4 s" counters between state updates. */
  private tickCountdowns() {
    const now = this.conn.clock.now();
    for (const b of this.dock.querySelectorAll<HTMLElement>('[data-at]')) b.textContent = `${secondsLeft(Number(b.dataset.at), now)} s`;
  }
}
