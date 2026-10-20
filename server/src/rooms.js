// Server-authoritative playback state for one Activity instance.
//
// The room stores the position at `updatedAt`. While it is running (not paused
// and nobody is being waited for), the current position is extrapolated from the
// clock. Viewers that stall are put in `waiting`: the room freezes until they are
// ready again, or until WAIT_TIMEOUT_MS passes (then they catch up on their own).
//
// Social layer, also server-authoritative (see "Regarder ensemble" in the README):
// - Roles. One host, co-pilotes promoted by the host, viewers. Default control mode
//   "host" (protected): only the host and co-pilotes play/pause/seek/stop/start;
//   viewers send requests (accepted/refused by a host or co-pilote, expiring after
//   REQUEST_TTL_MS) or vote (strict majority of present members, at least 2 votes).
//   The host may switch to "all" (everyone controls).
// - Continuity. Nothing depends on one person: the film goes on when anyone leaves;
//   an absent host is replaced after HOST_GRACE_MS (longest-present co-pilote, then
//   longest-present member) and comes back as co-pilote; roles and admission survive
//   reconnects; an emptied room is kept (paused) for EMPTY_ROOM_TTL_MS.
// - Waiting room (website rooms): newcomers wait in `pending` until a host or
//   co-pilote lets them in (or "accept everyone automatically" is on).
// - Moderation: the host kicks (blocked for the room's lifetime), promotes/revokes
//   co-pilotes, hands over. Every action is rate-limited per person; spammers are
//   muted for SPAM_COOLDOWN_MS and the moderators are told. Too many stalls from one
//   viewer stop freezing the room.
// - A queue of suggestions with votes, auto-started once a majority agrees, and
//   auto-next at the end of a series episode.
//
// Room methods never do I/O. What the server must say or do is pushed to `outbox`
// (notices, stream starts, kicks) and drained by index.js.

export const WAIT_TIMEOUT_MS = 10_000;
export const LOAD_TIMEOUT_MS = 20_000;
/** Once most of a room (3+ people) is ready, the last ones get at most this long. */
export const STRAGGLER_WAIT_MS = 8_000;
/** Requests ("Demander une pause") expire after this. */
export const REQUEST_TTL_MS = 20_000;
/** Votes to pause/skip expire after this. */
export const ACTION_VOTE_TTL_MS = 60_000;
/** Countdown before a suggestion voted by the majority starts. */
export const AUTOSTART_MS = 5_000;
/** Countdown before the next episode starts. */
export const AUTONEXT_MS = 10_000;
/** An emptied room keeps its film (paused) and queue this long. */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/** A host who dropped out is replaced after this (a reconnect keeps the crown). */
export const HOST_GRACE_MS = 15_000;
/** Someone refused at the door can't knock again for this long. */
export const REFUSE_BLOCK_MS = 2 * 60_000;
/** Muted after exceeding a rate limit. */
export const SPAM_COOLDOWN_MS = 30_000;
/** At most this many waits per viewer per minute; more stalls don't freeze the room. */
export const STALLS_PER_MINUTE = 4;
/** After the room gave up on a viewer, a new stall report waits this long instead. */
export const RETRY_WAIT_MS = 5_000;
/** ...at most this many times per minute per viewer. */
export const RETRIES_PER_MINUTE = 2;
export const MIN_VOTES = 2;
export const QUEUE_MAX = 30;
export const QUEUE_PER_USER_MAX = 5;
export const REQUESTS_MAX = 10;
export const PENDING_MAX = 20;

/** Per person: [max actions, window ms]. */
export const LIMITS = {
  control: [6, 10_000], // play/pause/seek/stop/start applied directly
  request: [3, 10_000],
  vote: [10, 10_000],
  propose: [5, 60_000],
};

const CONTROL_KINDS = ['play', 'pause', 'seek'];
const REQUEST_KINDS = ['play', 'pause', 'seek', 'start'];
const ACTION_VOTE_KINDS = ['pause', 'skip'];

/** 3725 → "1:02:05", 75 → "1:15". */
export function formatTime(s) {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** "Dune" or "Breaking Bad · S1E04" (episode code only). */
export function mediaLabel({ title, subtitle } = {}) {
  const code = String(subtitle || '').split(' · ')[0];
  return [String(title || '').trim() || 'la vidéo', code].filter(Boolean).join(' · ');
}

/** Strict majority of the present members, and never a single vote. */
export const majority = (count, total) => count >= MIN_VOTES && count * 2 > total;

export class Room {
  /**
   * @param lobby  waiting room for newcomers (website rooms)
   * @param owner  uid that always gets in and takes the crown (personal website room)
   */
  constructor(id, { now = Date.now, lobby = false, owner = null } = {}) {
    this.id = id;
    this.now = now;
    this.members = new Map(); // uid -> { uid, name, avatar, connections, quality, order, presence, external }
    this.waiting = new Map(); // uid -> deadline (ms)
    this.media = null;
    this.paused = true;
    this.position = 0;
    this.updatedAt = now();
    this.rev = 0;

    this.lobby = lobby;
    this.owner = owner;
    this.autoAdmit = false;
    this.pending = new Map(); // uid -> { uid, name, avatar, connections, since }
    this.admitted = new Set(); // uids let in once (a reconnect doesn't wait again)
    this.blocked = new Map(); // uid -> until (ms), Infinity once kicked

    this.control = 'host';
    this.host = null;
    this.hostAwayAt = null;
    this.copilots = new Set();

    this.queue = new Map(); // id -> item (votes: Set of uids)
    this.requests = new Map(); // id -> { id, uid, kind, position, itemId, expires }
    this.actionVotes = new Map(); // kind -> { kind, voters: Set, expires }
    this.autostart = null; // { itemId, at }
    this.autostartSuppressed = null; // { itemId, count } after a cancel
    this.autonext = null; // { at }
    this.autonextCancelled = null; // media sid
    this.starting = null; // { token, title, by }
    this.startSeq = 0;

    this.hits = new Map(); // `${uid}:${bucket}` -> timestamps
    this.stalls = new Map(); // uid -> timestamps
    this.gaveUp = new Map(); // uid -> when the room last stopped waiting for them
    this.retries = new Map(); // uid -> timestamps of second-chance waits
    this.muted = new Map(); // uid -> until

    this.emptySince = now(); // nobody yet
    this.pausedEmpty = false;
    this.outbox = [];
    this.seq = 0;
  }

  get running() {
    return !!this.media && !this.paused && this.waiting.size === 0;
  }

  currentPosition(at = this.now()) {
    if (!this.running) return this.position;
    const pos = this.position + (at - this.updatedAt) / 1000;
    const duration = this.media?.duration;
    return duration ? Math.min(pos, duration) : pos;
  }

  /** The media reached its end (its last second). */
  get ended() {
    const d = this.media?.duration;
    return !!d && this.currentPosition() >= d - 1;
  }

  /** Nothing to watch right now. */
  get idle() {
    return !this.media || this.ended;
  }

  /** Pins the extrapolated position before any state change. */
  #settle() {
    const t = this.now();
    this.position = this.currentPosition(t);
    this.updatedAt = t;
  }

  #changed() {
    this.rev++;
    return true;
  }

  #clamp(pos) {
    const p = Number(pos);
    if (!Number.isFinite(p) || p < 0) return 0;
    const duration = this.media?.duration;
    return duration ? Math.min(p, Math.max(0, duration - 1)) : p;
  }

  #id() {
    return (++this.seq).toString(36);
  }

  #name(uid) {
    return this.members.get(uid)?.name || this.pending.get(uid)?.name || 'Quelqu’un';
  }

  /** Notice for the room. `except`: not to that uid; `to`: only that uid or those uids. */
  #notice(text, { except = null, to = null } = {}) {
    this.outbox.push({ type: 'notice', text, except, to });
  }

  #toModerators(text) {
    const to = this.moderators();
    if (to.length) this.#notice(text, { to });
  }

  /** Takes what index.js must send/do (notices, stream starts, kicks). */
  drain() {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  // ------------------------------------------------------------ roles & permissions

  isModerator(uid) {
    return this.members.has(uid) && (uid === this.host || this.copilots.has(uid));
  }

  /** Present host and co-pilotes (who answer requests and the waiting room). */
  moderators() {
    return [...this.members.keys()].filter((uid) => this.isModerator(uid));
  }

  /** Play/pause/seek/stop/start a title directly. */
  canControl(uid) {
    if (!this.members.has(uid)) return false;
    return this.control === 'all' || this.isModerator(uid);
  }

  /** Starting something for the whole room (same rule: requests/votes otherwise). */
  canStart(uid) {
    return this.canControl(uid);
  }

  /**
   * Rate limit per person and bucket. Over the limit: muted for SPAM_COOLDOWN_MS
   * (every limited action is dropped), the person and the moderators are told.
   * The host is trusted (never limited).
   */
  #allow(uid, bucket) {
    if (uid === this.host && this.members.has(uid)) return true;
    const t = this.now();
    const until = this.muted.get(uid);
    if (until && until > t) return false;
    const [max, windowMs] = LIMITS[bucket];
    const key = `${uid}:${bucket}`;
    const list = (this.hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      this.muted.set(uid, t + SPAM_COOLDOWN_MS);
      this.#notice(`Doucement : tes actions sont ignorées pendant ${SPAM_COOLDOWN_MS / 1000} s`, { to: uid });
      const mods = this.moderators().filter((m) => m !== uid);
      if (mods.length) this.#notice(`${this.#name(uid)} envoie trop d’actions : ignoré ${SPAM_COOLDOWN_MS / 1000} s`, { to: mods });
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }

  isMuted(uid) {
    const until = this.muted.get(uid);
    return !!until && until > this.now();
  }

  /** Longest-present co-pilote, else longest-present member. */
  #successor() {
    let best = null;
    for (const m of this.members.values()) {
      const rank = [this.copilots.has(m.uid) ? 0 : 1, m.order];
      if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { m, rank };
    }
    return best?.m || null;
  }

  /** Gives the crown to the successor; the absent host comes back as co-pilote. */
  #replaceHost() {
    const next = this.#successor();
    if (!next) return false;
    const old = this.host;
    if (old && old !== next.uid) this.copilots.add(old);
    this.copilots.delete(next.uid);
    this.host = next.uid;
    this.hostAwayAt = null;
    this.#notice(`${next.name} est maintenant l’hôte`);
    return true;
  }

  /** Switches between "host" (protected, default) and "all". Host only. */
  setControl(uid, mode) {
    if (uid !== this.host || !this.members.has(uid) || !['all', 'host'].includes(mode) || mode === this.control) return false;
    this.control = mode;
    this.requests.clear();
    this.actionVotes.clear();
    this.#notice(
      mode === 'host'
        ? `${this.#name(uid)} a protégé la salle : l’hôte et les co-pilotes contrôlent`
        : `${this.#name(uid)} a donné le contrôle à tout le monde`
    );
    return this.#changed();
  }

  /** The host hands the crown to someone present; they become co-pilote. */
  handOver(uid, target) {
    if (uid !== this.host || target === uid || !this.members.has(uid) || !this.members.has(target)) return false;
    this.host = target;
    this.copilots.delete(target);
    this.copilots.add(uid);
    this.#notice(`${this.#name(uid)} a passé l’hôte à ${this.#name(target)}`);
    return this.#changed();
  }

  /** The host promotes (true) or revokes (false) a co-pilote. */
  setCopilot(uid, target, value) {
    if (uid !== this.host || target === uid || !this.members.has(uid) || !this.members.has(target)) return false;
    if (value === this.copilots.has(target)) return false;
    if (value) this.copilots.add(target);
    else this.copilots.delete(target);
    this.#notice(value ? `${this.#name(target)} est co-pilote` : `${this.#name(target)} n’est plus co-pilote`);
    return this.#changed();
  }

  /** The host removes someone (member or waiting) and blocks them for this room. */
  kick(uid, target) {
    if (uid !== this.host || target === uid || !this.members.has(uid)) return false;
    if (!this.members.has(target) && !this.pending.has(target)) return false;
    const name = this.#name(target);
    this.#forget(target);
    this.blocked.set(target, Infinity);
    this.outbox.push({ type: 'kick', uid: target, reason: 'kicked' });
    this.#notice(`${this.#name(uid)} a exclu ${name}`);
    this.#evaluate();
    return this.#changed();
  }

  /** Removes every trace of someone (kick). */
  #forget(target) {
    if (this.members.has(target)) this.#settle();
    this.members.delete(target);
    this.pending.delete(target);
    this.admitted.delete(target);
    this.copilots.delete(target);
    this.waiting.delete(target);
    for (const [id, r] of this.requests) if (r.uid === target) this.requests.delete(id);
    for (const v of this.actionVotes.values()) v.voters.delete(target);
    for (const [id, q] of this.queue) {
      if (q.uid === target) this.queue.delete(id);
      else q.votes.delete(target);
    }
  }

  // ------------------------------------------------------------ members & waiting room

  /** "member", "pending", "blocked" or "none". */
  status(uid) {
    const until = this.blocked.get(uid);
    if (until && until > this.now()) return 'blocked';
    if (this.members.has(uid)) return 'member';
    if (this.pending.has(uid)) return 'pending';
    return 'none';
  }

  /** A connection opens. Returns true when the room changed. */
  join({ uid, name, avatar }) {
    if (this.status(uid) === 'blocked') return false;
    const existing = this.members.get(uid) || this.pending.get(uid);
    if (existing) {
      existing.connections++;
      return false;
    }
    const isOwner = !!this.owner && uid === this.owner;
    const mustWait = this.lobby && !this.autoAdmit && !isOwner && !this.admitted.has(uid) && this.members.size > 0;
    if (mustWait) {
      if (this.pending.size >= PENDING_MAX) return false;
      this.pending.set(uid, { uid, name, avatar, connections: 1, since: this.now() });
      this.#toModerators(`${name} attend pour entrer`);
      return this.#changed();
    }
    this.#addMember({ uid, name, avatar, connections: 1 });
    if (isOwner && this.host !== uid) {
      if (this.host) this.copilots.add(this.host);
      this.copilots.delete(uid);
      this.host = uid;
    }
    this.#evaluate();
    return this.#changed();
  }

  #addMember({ uid, name, avatar, connections }) {
    this.members.set(uid, { uid, name, avatar, connections, quality: null, order: ++this.seq, presence: 'watching', external: false });
    this.admitted.add(uid);
    this.emptySince = null;
    if (uid === this.host) this.hostAwayAt = null;
    if (this.members.size === 1 && this.host !== uid) {
      // Alone in the room: somebody must be able to drive it.
      if (this.host) this.copilots.add(this.host);
      this.copilots.delete(uid);
      this.host = uid;
      this.hostAwayAt = null;
    }
    if (this.pausedEmpty && this.media) {
      // Back in a room everybody had left: the film goes on once this viewer has loaded it.
      this.pausedEmpty = false;
      this.paused = false;
      this.updatedAt = this.now();
      this.waiting.set(uid, this.now() + LOAD_TIMEOUT_MS);
    }
  }

  /** A host or co-pilote lets someone in from the waiting room. */
  admit(uid, target) {
    const p = this.pending.get(target);
    if (!p || !this.isModerator(uid)) return false;
    this.pending.delete(target);
    this.#addMember(p);
    this.#notice(`${this.#name(uid)} a fait entrer ${p.name}`);
    this.#evaluate();
    return this.#changed();
  }

  /** A host or co-pilote refuses someone: they can't knock again for REFUSE_BLOCK_MS. */
  refuse(uid, target) {
    const p = this.pending.get(target);
    if (!p || !this.isModerator(uid)) return false;
    this.pending.delete(target);
    this.blocked.set(target, this.now() + REFUSE_BLOCK_MS);
    this.outbox.push({ type: 'kick', uid: target, reason: 'refused' });
    return this.#changed();
  }

  /** "Accepter tout le monde automatiquement" (host or co-pilote). */
  setAutoAdmit(uid, value) {
    if (!this.isModerator(uid) || typeof value !== 'boolean' || value === this.autoAdmit) return false;
    this.autoAdmit = value;
    if (value) for (const p of [...this.pending.values()]) {
      this.pending.delete(p.uid);
      this.#addMember(p);
    }
    this.#evaluate();
    return this.#changed();
  }

  leave(uid) {
    const p = this.pending.get(uid);
    if (p) {
      if (--p.connections > 0) return false;
      this.pending.delete(uid);
      return this.#changed();
    }
    const m = this.members.get(uid);
    if (!m) return false;
    if (--m.connections > 0) return false;
    this.#settle();
    this.members.delete(uid);
    this.waiting.delete(uid);
    for (const [id, r] of this.requests) if (r.uid === uid) this.requests.delete(id);
    for (const v of this.actionVotes.values()) v.voters.delete(uid);
    if (uid === this.host) this.hostAwayAt = this.now();
    if (this.members.size === 0) {
      // Somebody waiting at the door while everybody left: let the first one in.
      const first = [...this.pending.values()].sort((a, b) => a.since - b.since)[0];
      if (first) {
        this.pending.delete(first.uid);
        this.#addMember(first);
      }
    }
    if (this.members.size === 0) {
      // Nobody left: keep the film where it is, it resumes when someone comes back.
      this.emptySince = this.now();
      if (this.media && !this.paused) {
        this.paused = true;
        this.pausedEmpty = true;
      }
      this.requests.clear();
      this.actionVotes.clear();
      this.autostart = null;
      this.autonext = null;
    }
    this.#evaluate();
    return this.#changed();
  }

  get empty() {
    return this.members.size === 0;
  }

  setPresence(uid, presence) {
    const m = this.members.get(uid);
    if (!m || !['watching', 'browsing'].includes(presence) || m.presence === presence) return false;
    m.presence = presence;
    return this.#changed();
  }

  // ------------------------------------------------------------ playback primitives

  /** New media: everyone currently here loads it, playback starts when all are ready. */
  load(media, { startAt = 0 } = {}) {
    this.media = media;
    this.paused = false;
    this.pausedEmpty = false;
    this.position = this.#clamp(startAt);
    this.updatedAt = this.now();
    this.waiting.clear();
    this.gaveUp.clear();
    this.retries.clear();
    const deadline = this.now() + LOAD_TIMEOUT_MS;
    for (const m of this.members.values()) if (!m.external) this.waiting.set(m.uid, deadline);
    this.starting = null;
    this.requests.clear();
    this.actionVotes.clear();
    this.autostart = null;
    this.autonext = null;
    this.autonextCancelled = null;
    return this.#changed();
  }

  stop() {
    this.media = null;
    this.paused = true;
    this.pausedEmpty = false;
    this.position = 0;
    this.waiting.clear();
    this.requests.clear();
    this.actionVotes.clear();
    this.autonext = null;
    this.#evaluate();
    return this.#changed();
  }

  play() {
    if (!this.media || !this.paused) return false;
    this.#settle();
    this.paused = false;
    return this.#changed();
  }

  pause() {
    if (!this.media || this.paused) return false;
    this.#settle();
    this.paused = true;
    return this.#changed();
  }

  seek(pos) {
    if (!this.media) return false;
    this.#settle();
    this.position = this.#clamp(pos);
    return this.#changed();
  }

  /** The media's GPU encoder came or went (encoder.js): everyone reloads their stream. */
  setEncoder(sid, encoder) {
    if (this.media?.sid !== sid) return false;
    if (JSON.stringify(this.media.encoder || null) === JSON.stringify(encoder || null)) return false;
    this.media = { ...this.media, encoder: encoder || null };
    return this.#changed();
  }

  /** A viewer stalled (true) or is ready/playing again (false). */
  setBuffering(uid, buffering) {
    if (!this.media || !this.members.has(uid)) return false;
    if (buffering) {
      // Watching in an external player: their page doesn't play, it never holds the room.
      if (this.members.get(uid).external) return false;
      if (this.waiting.has(uid) || this.paused) return false;
      // A viewer stalling again and again (bad link, or on purpose) stops holding the room.
      const t = this.now();
      const recent = (this.stalls.get(uid) || []).filter((x) => t - x < 60_000);
      if (recent.length >= STALLS_PER_MINUTE) {
        this.stalls.set(uid, recent);
        return false;
      }
      // Second chance after the room gave up on them (still loading): a shorter wait,
      // at most RETRIES_PER_MINUTE times, so one bad link can't keep freezing the room.
      const gaveUp = this.gaveUp.get(uid);
      const retry = gaveUp !== undefined && t - gaveUp < 60_000;
      if (retry) {
        const retries = (this.retries.get(uid) || []).filter((x) => t - x < 60_000);
        if (retries.length >= RETRIES_PER_MINUTE) {
          this.retries.set(uid, retries);
          return false;
        }
        retries.push(t);
        this.retries.set(uid, retries);
      }
      recent.push(t);
      this.stalls.set(uid, recent);
      this.#settle();
      this.waiting.set(uid, t + (retry ? RETRY_WAIT_MS : WAIT_TIMEOUT_MS));
      return this.#changed();
    }
    if (!this.waiting.has(uid)) return false;
    this.#settle();
    this.waiting.delete(uid);
    this.#hurryStragglers();
    return this.#changed();
  }

  /**
   * In a group, one slow device must not hold everyone for the full wait: when more than
   * half of the watchers are ready, the others get STRAGGLER_WAIT_MS more at most (then
   * they catch up on their own, as after any wait).
   */
  #hurryStragglers() {
    const watchers = [...this.members.values()].filter((m) => !m.external).length;
    if (watchers < 3 || !this.waiting.size) return;
    const ready = watchers - this.waiting.size;
    if (ready * 2 <= watchers) return;
    const cap = this.now() + STRAGGLER_WAIT_MS;
    for (const [uid, deadline] of this.waiting) if (deadline > cap) this.waiting.set(uid, cap);
  }

  /**
   * "Lecteur externe": this viewer plays the file in VLC & co. The room never waits for
   * them (their player doesn't follow the room on its own); their page is a remote.
   */
  setExternal(uid, value) {
    const m = this.members.get(uid);
    if (!m || typeof value !== 'boolean' || m.external === value) return false;
    m.external = value;
    if (value && this.waiting.has(uid)) {
      this.#settle();
      this.waiting.delete(uid);
    }
    return this.#changed();
  }

  setQuality(uid, quality) {
    const m = this.members.get(uid);
    if (!m || m.quality === quality) return false;
    m.quality = typeof quality === 'string' ? quality.slice(0, 16) : null;
    return this.#changed();
  }

  // ------------------------------------------------------------ actions with attribution

  /**
   * Play/pause/seek from a member, with attribution. Without the right, it becomes a
   * request to the host and co-pilotes instead.
   */
  act(uid, kind, value) {
    if (!this.media || !this.members.has(uid) || !CONTROL_KINDS.includes(kind)) return false;
    if (!this.canControl(uid)) return this.request(uid, kind, value);
    if (!this.#allow(uid, 'control')) return false;
    const before = this.currentPosition();
    const ok = this.#apply(kind, value);
    if (ok) this.#notice(this.#describe(this.#name(uid), kind, this.position, before), { except: uid });
    this.#evaluate();
    return ok;
  }

  /** Stop for everyone (controllers only). */
  stopBy(uid) {
    if (!this.media || !this.canControl(uid) || !this.#allow(uid, 'control')) return false;
    this.stop();
    this.#notice(`${this.#name(uid)} a arrêté la lecture`, { except: uid });
    return true;
  }

  #apply(kind, value) {
    if (kind === 'play') return this.play();
    if (kind === 'pause') return this.pause();
    return this.seek(value);
  }

  #describe(name, kind, position, before) {
    if (kind === 'play') return `${name} a repris la lecture`;
    if (kind === 'pause') return `${name} a mis en pause`;
    return `${name} ${position >= before ? 'a avancé' : 'a reculé'} à ${formatTime(position)}`;
  }

  // ------------------------------------------------------------ requests

  /** A viewer asks the host/co-pilotes: pause, play, seek (position) or start (item id). */
  request(uid, kind, value) {
    if (!this.members.has(uid) || this.canControl(uid) || !REQUEST_KINDS.includes(kind)) return false;
    let position = null;
    let itemId = null;
    if (kind === 'start') {
      if (!this.queue.has(value)) return false;
      itemId = value;
    } else {
      if (!this.media) return false;
      if ((kind === 'pause' && this.paused) || (kind === 'play' && !this.paused)) return false;
      if (kind === 'seek') position = this.#clamp(value);
    }
    if (!this.#allow(uid, 'request')) return false;
    for (const [id, r] of this.requests) if (r.uid === uid) this.requests.delete(id); // one per person
    if (this.requests.size >= REQUESTS_MAX) return false;
    const id = this.#id();
    this.requests.set(id, { id, uid, kind, position, itemId, expires: this.now() + REQUEST_TTL_MS });
    const mods = this.moderators();
    this.#notice(mods.length ? 'Demande envoyée à l’hôte' : 'Demande envoyée (l’hôte n’est pas là : votez !)', { to: uid });
    return this.#changed();
  }

  #requestLabel(r) {
    if (r.kind === 'pause') return 'une pause';
    if (r.kind === 'play') return 'de reprendre';
    if (r.kind === 'seek') return `d’aller à ${formatTime(r.position)}`;
    const item = this.queue.get(r.itemId);
    return `de lancer « ${item ? mediaLabel(item) : '…'} »`;
  }

  /** A host or co-pilote accepts or refuses a request. */
  respond(uid, id, accept) {
    const r = this.requests.get(id);
    if (!r || !this.isModerator(uid)) return false;
    this.requests.delete(id);
    const who = this.#name(uid);
    const label = this.#requestLabel(r);
    if (accept) {
      this.#notice(`${who} a accepté la demande de ${this.#name(r.uid)} (${label})`);
      if (r.kind === 'start') {
        const item = this.queue.get(r.itemId);
        if (item) this.#startItem(item, { by: uid, reason: 'request' });
      } else {
        this.#apply(r.kind, r.position);
      }
    } else {
      this.#notice(`${who} a refusé la demande de ${this.#name(r.uid)} (${label})`);
    }
    this.#evaluate();
    return this.#changed();
  }

  /** Withdraws one's own request. */
  cancelRequest(uid, id) {
    const r = this.requests.get(id);
    if (!r || r.uid !== uid) return false;
    this.requests.delete(id);
    return this.#changed();
  }

  // ------------------------------------------------------------ votes to pause / skip

  /** Toggles uid's vote to pause or skip; applied as soon as a majority agrees. */
  voteAction(uid, kind) {
    if (!this.media || !this.members.has(uid) || !ACTION_VOTE_KINDS.includes(kind)) return false;
    if (!this.#allow(uid, 'vote')) return false;
    let v = this.actionVotes.get(kind);
    if (!v) {
      if (kind === 'pause' && this.paused) return false;
      v = { kind, voters: new Set(), expires: this.now() + ACTION_VOTE_TTL_MS };
      this.actionVotes.set(kind, v);
    }
    if (v.voters.has(uid)) v.voters.delete(uid);
    else {
      if (v.voters.size === 0) {
        this.#notice(
          kind === 'pause' ? `${this.#name(uid)} propose une pause (vote)` : `${this.#name(uid)} propose de passer (vote)`,
          { except: uid }
        );
      }
      v.voters.add(uid);
    }
    if (v.voters.size === 0) this.actionVotes.delete(kind);
    this.#evaluate();
    return this.#changed();
  }

  /** Skip what plays: next episode, else the top suggestion, else stop. */
  #skip() {
    if (this.media?.next) {
      this.#startNext('La salle a voté pour passer · ');
      return;
    }
    const top = this.sortedQueue()[0];
    if (top) {
      this.#startItem(top, { by: null, reason: 'skip' });
      return;
    }
    this.#notice('La salle a voté pour passer');
    this.stop();
  }

  // ------------------------------------------------------------ queue (suggestions)

  /**
   * Adds a suggestion (the proposer's vote included). The same video twice = a vote
   * for the existing one. Returns { item } or { error }.
   *
   * item: { meta: { id, type, videoId }, title, subtitle, poster, streamKey?, source? }
   */
  propose(uid, item) {
    if (!this.members.has(uid)) return { error: 'Tu n’es pas dans la salle' };
    if (!this.#allow(uid, 'propose')) {
      return { error: this.isMuted(uid) ? 'Doucement : réessaie dans quelques secondes' : 'Trop de propositions, attends un peu' };
    }
    const existing = [...this.queue.values()].find((q) => q.meta.videoId === item.meta.videoId);
    if (existing) {
      if (!existing.votes.has(uid)) {
        existing.votes.add(uid);
        this.#evaluate();
        this.#changed();
      }
      return { item: existing, duplicate: true };
    }
    if (this.queue.size >= QUEUE_MAX) return { error: 'La file d’attente est pleine' };
    const mine = [...this.queue.values()].filter((q) => q.uid === uid).length;
    if (mine >= QUEUE_PER_USER_MAX) return { error: `Maximum ${QUEUE_PER_USER_MAX} propositions par personne` };
    const id = this.#id();
    const entry = {
      id,
      uid,
      name: this.#name(uid),
      meta: item.meta,
      title: item.title,
      subtitle: item.subtitle || '',
      poster: item.poster || null,
      streamKey: item.streamKey || null,
      source: item.source || null,
      votes: new Set([uid]),
      createdAt: this.now(),
      order: this.seq,
    };
    this.queue.set(id, entry);
    this.#notice(`${entry.name} propose « ${mediaLabel(entry)} »`, { except: uid });
    this.#evaluate();
    this.#changed();
    return { item: entry };
  }

  /** Most votes first, then oldest. */
  sortedQueue() {
    return [...this.queue.values()].sort((a, b) => b.votes.size - a.votes.size || a.createdAt - b.createdAt || a.order - b.order);
  }

  /** Toggles uid's 👍 on a suggestion. */
  vote(uid, itemId) {
    const item = this.queue.get(itemId);
    if (!item || !this.members.has(uid) || !this.#allow(uid, 'vote')) return false;
    if (item.votes.has(uid)) item.votes.delete(uid);
    else item.votes.add(uid);
    this.#evaluate();
    return this.#changed();
  }

  /** The proposer, the host or a co-pilote removes a suggestion. */
  withdraw(uid, itemId) {
    const item = this.queue.get(itemId);
    if (!item || !this.members.has(uid)) return false;
    if (item.uid !== uid && !this.isModerator(uid)) return false;
    this.queue.delete(itemId);
    for (const [id, r] of this.requests) if (r.itemId === itemId) this.requests.delete(id);
    this.#evaluate();
    return this.#changed();
  }

  /** "Lancer" on a suggestion: controllers start it, others ask for it. */
  startSuggestion(uid, itemId) {
    const item = this.queue.get(itemId);
    if (!item || !this.members.has(uid)) return false;
    if (!this.canStart(uid)) return this.request(uid, 'start', itemId);
    if (!this.#allow(uid, 'control')) return false;
    this.#startItem(item, { by: uid, reason: 'manual' });
    return this.#changed();
  }

  /**
   * Marks a start in progress (shown to everyone) and returns its token: only the
   * latest start may load (index.js checks isCurrentStart before room.load).
   */
  beginStart({ title, subtitle, by = null, announce = null }) {
    const token = ++this.startSeq;
    this.starting = { token, title: mediaLabel({ title, subtitle }), by: by ? this.#name(by) : null };
    this.autostart = null;
    this.autonext = null;
    if (announce) this.#notice(announce, { except: by });
    this.#changed();
    return token;
  }

  /** HTTP "Regarder ensemble": controllers only, rate-limited. Returns a token or null. */
  beginStartBy(uid, { title, subtitle, announce }) {
    if (!this.canStart(uid) || !this.#allow(uid, 'control')) return null;
    return this.beginStart({ title, subtitle, by: uid, announce });
  }

  isCurrentStart(token) {
    return this.startSeq === token;
  }

  /** A start failed (stream error...): drop the "starting" state. */
  failStart(token) {
    if (this.starting?.token !== token) return false;
    this.starting = null;
    this.#evaluate();
    return this.#changed();
  }

  #startItem(item, { by, reason }) {
    this.queue.delete(item.id);
    for (const [id, r] of this.requests) if (r.itemId === item.id) this.requests.delete(id);
    if (this.autostartSuppressed?.itemId === item.id) this.autostartSuppressed = null;
    const label = mediaLabel(item);
    const announce =
      reason === 'vote'
        ? `La salle a voté pour « ${label} »`
        : reason === 'skip'
          ? `La salle a voté pour passer · « ${label} »`
          : reason === 'request'
            ? null // the acceptance notice says it
            : `${this.#name(by)} a lancé « ${label} »`;
    const token = this.beginStart({ title: item.title, subtitle: item.subtitle, by: reason === 'manual' ? by : null, announce });
    this.outbox.push({
      type: 'start',
      token,
      by: by || null,
      item: {
        // The proposer's addons find a source when none was chosen (or it expired).
        uid: item.uid,
        meta: item.meta,
        title: item.title,
        subtitle: item.subtitle,
        poster: item.poster,
        streamKey: item.streamKey,
        proposer: item.name,
      },
    });
  }

  // ------------------------------------------------------------ auto-next episode

  /** What follows the current media (a series episode), found by index.js after load. */
  setNext(sid, next) {
    if (!this.media || this.media.sid !== sid) return false;
    this.media = { ...this.media, next };
    this.#evaluate();
    return this.#changed();
  }

  #startNext(prefix = '') {
    const media = this.media;
    const next = media.next;
    const token = this.beginStart({
      title: media.title,
      subtitle: next.subtitle,
      announce: `${prefix}Épisode suivant : ${mediaLabel({ title: media.title, subtitle: next.subtitle })}`,
    });
    this.outbox.push({
      type: 'start',
      token,
      by: null,
      item: {
        // Same addons as whoever started this one, same ranking.
        uid: media.startedByUid || this.host,
        meta: { id: media.meta?.id, type: media.meta?.type, videoId: next.videoId },
        title: media.title,
        subtitle: next.subtitle,
        poster: media.poster,
        streamKey: null,
        proposer: media.startedBy || null,
      },
    });
  }

  /** Cancels a countdown ("autostart" or "autonext"): whoever controls. */
  cancel(uid, what) {
    if (!this.canControl(uid)) return false;
    if (what === 'autostart' && this.autostart) {
      const item = this.queue.get(this.autostart.itemId);
      this.autostartSuppressed = item ? { itemId: item.id, count: this.#presentVotes(item.votes) } : null;
      this.autostart = null;
      this.#notice(`${this.#name(uid)} a annulé le lancement automatique`, { except: uid });
      return this.#changed();
    }
    if (what === 'autonext' && this.autonext) {
      this.autonext = null;
      this.autonextCancelled = this.media?.sid || null;
      this.#notice(`${this.#name(uid)} a annulé l’épisode suivant`, { except: uid });
      return this.#changed();
    }
    return false;
  }

  // ------------------------------------------------------------ rules evaluation

  #presentVotes(set) {
    let n = 0;
    for (const uid of set) if (this.members.has(uid)) n++;
    return n;
  }

  /** Applies majorities and arms/disarms countdowns. Returns true if state changed. */
  #evaluate() {
    let changed = false;
    const total = this.members.size;

    for (const [kind, v] of this.actionVotes) {
      if (!majority(this.#presentVotes(v.voters), total)) continue;
      this.actionVotes.delete(kind);
      changed = true;
      if (kind === 'pause') {
        this.pause();
        this.#notice('La salle a voté : pause');
      } else {
        this.#skip();
      }
    }

    // Next episode once this one is over.
    const wantNext =
      total > 0 && !!this.media?.next && this.ended && !this.starting && this.autonextCancelled !== this.media.sid;
    if (wantNext && !this.autonext) {
      this.autonext = { at: this.now() + AUTONEXT_MS };
      changed = true;
    } else if (!wantNext && this.autonext) {
      this.autonext = null;
      changed = true;
    }

    // Majority on the top suggestion while nothing plays.
    const top = this.sortedQueue()[0];
    const count = top ? this.#presentVotes(top.votes) : 0;
    const suppressed = top && this.autostartSuppressed?.itemId === top.id && count <= this.autostartSuppressed.count;
    const wantStart = !!top && this.idle && !this.starting && !this.autonext && majority(count, total) && !suppressed;
    if (wantStart && this.autostart?.itemId !== top.id) {
      this.autostart = { itemId: top.id, at: this.now() + AUTOSTART_MS };
      changed = true;
    } else if (!wantStart && this.autostart) {
      this.autostart = null;
      changed = true;
    }
    if (changed) this.#changed();
    return changed;
  }

  /** Deadlines: waits, host grace, requests, votes, countdowns. Returns true if state changed. */
  tick() {
    const t = this.now();
    let changed = false;
    for (const [uid, deadline] of this.waiting) {
      if (deadline <= t) {
        if (!changed) this.#settle();
        this.waiting.delete(uid);
        this.gaveUp.set(uid, t);
        changed = true;
      }
    }
    if (this.hostAwayAt !== null && !this.members.has(this.host) && this.members.size > 0 && t - this.hostAwayAt >= HOST_GRACE_MS) {
      if (this.#replaceHost()) changed = true;
    }
    for (const [id, r] of this.requests) {
      if (r.expires <= t) {
        this.requests.delete(id);
        this.#notice(`Ta demande (${this.#requestLabel(r)}) a expiré`, { to: r.uid });
        changed = true;
      }
    }
    for (const [kind, v] of this.actionVotes) {
      if (v.expires <= t) {
        this.actionVotes.delete(kind);
        changed = true;
      }
    }
    if (this.autonext && this.autonext.at <= t) {
      this.autonext = null;
      this.#startNext();
      changed = true;
    }
    if (this.autostart && this.autostart.at <= t) {
      const item = this.queue.get(this.autostart.itemId);
      this.autostart = null;
      if (item) this.#startItem(item, { by: null, reason: 'vote' });
      changed = true;
    }
    if (this.#evaluate()) changed = true;
    return changed ? this.#changed() : false;
  }

  snapshot() {
    const t = this.now();
    return {
      rev: this.rev,
      serverTime: t,
      media: this.media ? publicMedia(this.media) : null,
      paused: this.paused,
      running: this.running,
      position: this.currentPosition(t),
      ended: this.ended,
      waiting: [...this.waiting.keys()],
      members: [...this.members.values()].map(({ uid, name, avatar, quality, presence, external }) => ({
        uid,
        name,
        avatar,
        quality,
        state: this.waiting.has(uid) ? 'loading' : this.media ? presence : 'browsing',
        ...(external ? { external: true } : {}),
      })),
      control: this.control,
      host: this.host,
      copilots: [...this.copilots].filter((uid) => this.members.has(uid)),
      lobby: this.lobby,
      autoAdmit: this.autoAdmit,
      pending: [...this.pending.values()].map(({ uid, name, avatar, since }) => ({ uid, name, avatar, since })),
      muted: [...this.muted].filter(([, until]) => until > t).map(([uid]) => uid),
      queue: this.sortedQueue().map((q) => ({
        id: q.id,
        uid: q.uid,
        name: q.name,
        title: q.title,
        subtitle: q.subtitle,
        poster: q.poster,
        meta: q.meta,
        source: q.source,
        votes: [...q.votes],
        createdAt: q.createdAt,
      })),
      autostart: this.autostart && { itemId: this.autostart.itemId, at: this.autostart.at },
      autonext: this.autonext && this.media?.next ? { at: this.autonext.at, subtitle: this.media.next.subtitle } : null,
      starting: this.starting && { title: this.starting.title, by: this.starting.by },
      requests: [...this.requests.values()].map(({ id, uid, kind, position, itemId, expires }) => ({
        id,
        uid,
        name: this.#name(uid),
        kind,
        position,
        itemId,
        label: this.#requestLabel({ kind, position, itemId }),
        expires,
      })),
      votes: [...this.actionVotes.values()].map(({ kind, voters, expires }) => ({ kind, voters: [...voters], expires })),
    };
  }
}

/** Media as the browser sees it (no server-only fields). */
function publicMedia(media) {
  const { startedByUid, ...rest } = media;
  return rest;
}

export class Rooms {
  constructor(options) {
    this.options = options;
    this.rooms = new Map();
  }

  /** `init` (lobby, owner) applies when the room is created. */
  get(id, init = {}) {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id, { ...this.options, ...init });
      this.rooms.set(id, room);
    }
    return room;
  }

  peek(id) {
    return this.rooms.get(id) || null;
  }

  delete(id) {
    this.rooms.delete(id);
  }

  /** Forgets rooms that stayed empty for EMPTY_ROOM_TTL_MS. Returns the deleted ids. */
  sweep(now = (this.options?.now || Date.now)()) {
    const gone = [];
    for (const [id, room] of this.rooms) {
      if (room.empty && room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  [Symbol.iterator]() {
    return this.rooms.values();
  }
}
