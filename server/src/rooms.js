// Server-authoritative playback state for one Activity instance.
//
// The room stores the position at `updatedAt`. While it is running (not paused
// and nobody is being waited for), the current position is extrapolated from the
// clock. Viewers that stall are put in `waiting`: the room freezes until they are
// ready again, or until WAIT_TIMEOUT_MS passes (then they catch up on their own).
//
// Social layer (also server-authoritative, see "Regarder ensemble" in the README):
// - nobody owns the room: whoever started the Activity or the film can leave and the
//   film goes on; an emptied room is kept (paused) for EMPTY_ROOM_TTL_MS;
// - control mode "all" (anyone plays/pauses/seeks) or "host" (only the host does;
//   others send requests the host accepts/refuses, or vote to pause/skip);
// - a queue of suggestions with votes, auto-started once a majority agrees;
// - auto-next episode at the end of a series episode.
//
// Room methods never do I/O. Things the server must do or say are pushed to
// `outbox` (notices and stream starts) and drained by index.js.

export const WAIT_TIMEOUT_MS = 10_000;
export const LOAD_TIMEOUT_MS = 20_000;
/** Host-mode requests ("Demander une pause") expire after this. */
export const REQUEST_TTL_MS = 20_000;
/** Votes to pause/skip expire after this. */
export const ACTION_VOTE_TTL_MS = 60_000;
/** Countdown before a suggestion voted by the majority starts. */
export const AUTOSTART_MS = 5_000;
/** Countdown before the next episode starts. */
export const AUTONEXT_MS = 10_000;
/** An emptied room keeps its film (paused) and queue this long. */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
export const QUEUE_MAX = 30;
export const QUEUE_PER_USER_MAX = 5;
export const REQUESTS_MAX = 10;

const CONTROL_KINDS = ['play', 'pause', 'seek'];
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

const majority = (count, total) => total > 0 && count * 2 > total;

export class Room {
  constructor(id, { now = Date.now } = {}) {
    this.id = id;
    this.now = now;
    this.members = new Map(); // uid -> { uid, name, avatar, connections, quality, order, presence }
    this.waiting = new Map(); // uid -> deadline (ms)
    this.media = null;
    this.paused = true;
    this.position = 0;
    this.updatedAt = now();
    this.rev = 0;

    this.control = 'all';
    this.host = null;
    this.queue = new Map(); // id -> item (votes: Set of uids)
    this.requests = new Map(); // id -> { id, uid, kind, position, expires }
    this.actionVotes = new Map(); // kind -> { kind, voters: Set, expires }
    this.autostart = null; // { itemId, at }
    this.autostartSuppressed = null; // { itemId, count } after a cancel
    this.autonext = null; // { at }
    this.autonextCancelled = null; // media sid
    this.starting = null; // { token, title, by }
    this.startSeq = 0;
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

  /** Nothing to watch right now: anyone may start something. */
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
    return this.members.get(uid)?.name || 'Quelqu’un';
  }

  /** Notice for the room. `except`: not to that uid (their own action); `to`: only them. */
  #notice(text, { except = null, to = null } = {}) {
    this.outbox.push({ type: 'notice', text, except, to });
  }

  /** Takes what index.js must send/do (notices, stream starts). */
  drain() {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  // ------------------------------------------------------------ members

  join({ uid, name, avatar }) {
    const existing = this.members.get(uid);
    if (existing) {
      existing.connections++;
      return false;
    }
    this.members.set(uid, { uid, name, avatar, connections: 1, quality: null, order: ++this.seq, presence: 'watching' });
    this.emptySince = null;
    if (this.pausedEmpty && this.media) {
      // Back in a room everybody had left: the film goes on once this viewer has loaded it.
      this.pausedEmpty = false;
      this.paused = false;
      this.updatedAt = this.now();
      this.waiting.set(uid, this.now() + LOAD_TIMEOUT_MS);
    }
    this.#ensureHost();
    this.#evaluate();
    return this.#changed();
  }

  leave(uid) {
    const m = this.members.get(uid);
    if (!m) return false;
    if (--m.connections > 0) return false;
    this.#settle();
    this.members.delete(uid);
    this.waiting.delete(uid);
    for (const [id, r] of this.requests) if (r.uid === uid) this.requests.delete(id);
    for (const v of this.actionVotes.values()) v.voters.delete(uid);
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
    } else {
      this.#ensureHost();
    }
    this.#evaluate();
    return this.#changed();
  }

  get empty() {
    return this.members.size === 0;
  }

  /** The host left (or there is none): the longest-present member takes over. */
  #ensureHost() {
    if (this.host && this.members.has(this.host)) return false;
    if (this.members.size === 0) return false; // kept: the host may come back
    let next = null;
    for (const m of this.members.values()) if (!next || m.order < next.order) next = m;
    const had = this.host !== null;
    this.host = next.uid;
    if (had && this.control === 'host') this.#notice(`${next.name} est maintenant l’hôte`);
    return true;
  }

  setPresence(uid, presence) {
    const m = this.members.get(uid);
    if (!m || !['watching', 'browsing'].includes(presence) || m.presence === presence) return false;
    m.presence = presence;
    return this.#changed();
  }

  // ------------------------------------------------------------ playback primitives

  /** New media: everyone currently here loads it, playback starts when all are ready. */
  load(media, { startAt = 0, by = null } = {}) {
    this.media = media;
    this.paused = false;
    this.pausedEmpty = false;
    this.position = this.#clamp(startAt);
    this.updatedAt = this.now();
    this.waiting.clear();
    const deadline = this.now() + LOAD_TIMEOUT_MS;
    for (const uid of this.members.keys()) this.waiting.set(uid, deadline);
    // Whoever started it hosts it (if still here).
    if (by && this.members.has(by)) this.host = by;
    this.#ensureHost();
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

  /** A viewer stalled (true) or is ready/playing again (false). */
  setBuffering(uid, buffering) {
    if (!this.media || !this.members.has(uid)) return false;
    if (buffering) {
      if (this.waiting.has(uid) || this.paused) return false;
      this.#settle();
      this.waiting.set(uid, this.now() + WAIT_TIMEOUT_MS);
      return this.#changed();
    }
    if (!this.waiting.has(uid)) return false;
    this.#settle();
    this.waiting.delete(uid);
    return this.#changed();
  }

  setQuality(uid, quality) {
    const m = this.members.get(uid);
    if (!m || m.quality === quality) return false;
    m.quality = typeof quality === 'string' ? quality.slice(0, 16) : null;
    return this.#changed();
  }

  // ------------------------------------------------------------ permissions

  /** Play/pause/seek/stop/cancel the next episode. */
  canControl(uid) {
    return this.control === 'all' || uid === this.host;
  }

  /** Starting something: always when nothing plays, otherwise like canControl. */
  canStart(uid) {
    return this.idle || this.canControl(uid);
  }

  /**
   * Play/pause/seek from a member, with attribution. Without the right (host mode),
   * it becomes a request to the host instead.
   */
  act(uid, kind, value) {
    if (!this.media || !this.members.has(uid) || !CONTROL_KINDS.includes(kind)) return false;
    if (!this.canControl(uid)) return this.request(uid, kind, value);
    const before = this.currentPosition();
    const ok = this.#apply(kind, value);
    if (ok) this.#notice(this.#describe(this.#name(uid), kind, this.position, before), { except: uid });
    this.#evaluate();
    return ok;
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

  /** Switches between "all" and "host". Anyone may enable host mode; only the host may end it. */
  setControl(uid, mode) {
    if (!this.members.has(uid) || !['all', 'host'].includes(mode) || mode === this.control) return false;
    if (mode === 'all' && uid !== this.host) return false;
    this.control = mode;
    this.requests.clear();
    this.actionVotes.clear();
    this.#ensureHost();
    this.#notice(
      mode === 'host'
        ? `${this.#name(uid)} a activé « Seul l’hôte contrôle » · hôte : ${this.#name(this.host)}`
        : `${this.#name(uid)} a rendu le contrôle à tout le monde`
    );
    return this.#changed();
  }

  /** The host hands the crown to someone else. */
  handOver(uid, target) {
    if (uid !== this.host || target === uid || !this.members.has(target)) return false;
    this.host = target;
    this.#notice(`${this.#name(uid)} a passé l’hôte à ${this.#name(target)}`);
    return this.#changed();
  }

  // ------------------------------------------------------------ host-mode requests

  request(uid, kind, value) {
    if (!this.media || this.control !== 'host' || uid === this.host || !this.members.has(uid)) return false;
    if (!CONTROL_KINDS.includes(kind)) return false;
    if ((kind === 'pause' && this.paused) || (kind === 'play' && !this.paused)) return false;
    for (const [id, r] of this.requests) if (r.uid === uid) this.requests.delete(id); // one per person
    if (this.requests.size >= REQUESTS_MAX) return false;
    const id = this.#id();
    const position = kind === 'seek' ? this.#clamp(value) : null;
    this.requests.set(id, { id, uid, kind, position, expires: this.now() + REQUEST_TTL_MS });
    this.#notice(`Demande envoyée à ${this.#name(this.host)}`, { to: uid });
    return this.#changed();
  }

  #requestLabel(r) {
    if (r.kind === 'pause') return 'une pause';
    if (r.kind === 'play') return 'de reprendre';
    return `d’aller à ${formatTime(r.position)}`;
  }

  /** The host accepts or refuses a request. */
  respond(uid, id, accept) {
    const r = this.requests.get(id);
    if (!r || uid !== this.host) return false;
    this.requests.delete(id);
    const host = this.#name(uid);
    if (accept) {
      this.#apply(r.kind, r.position);
      this.#notice(`${host} a accepté la demande de ${this.#name(r.uid)} (${this.#requestLabel(r)})`);
    } else {
      this.#notice(`${host} a refusé la demande de ${this.#name(r.uid)} (${this.#requestLabel(r)})`);
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
    const media = this.media;
    if (media?.next) {
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
    if (!item || !this.members.has(uid)) return false;
    if (item.votes.has(uid)) item.votes.delete(uid);
    else item.votes.add(uid);
    this.#evaluate();
    return this.#changed();
  }

  /** The proposer (or the host in host mode) removes a suggestion. */
  withdraw(uid, itemId) {
    const item = this.queue.get(itemId);
    if (!item) return false;
    if (item.uid !== uid && !(this.control === 'host' && uid === this.host)) return false;
    this.queue.delete(itemId);
    this.#evaluate();
    return this.#changed();
  }

  /** "Lancer" on a suggestion. */
  startSuggestion(uid, itemId) {
    const item = this.queue.get(itemId);
    if (!item || !this.members.has(uid) || !this.canStart(uid)) return false;
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
    if (this.autostartSuppressed?.itemId === item.id) this.autostartSuppressed = null;
    const label = mediaLabel(item);
    const announce =
      reason === 'vote'
        ? `La salle a voté pour « ${label} »`
        : reason === 'skip'
          ? `La salle a voté pour passer : « ${label} »`
          : `${this.#name(by)} a lancé « ${label} »`;
    const token = this.beginStart({ title: item.title, subtitle: item.subtitle, by: reason === 'manual' ? by : null, announce });
    this.outbox.push({
      type: 'start',
      token,
      // The proposer's addons are used to find a source; they host it if present.
      host: reason === 'manual' ? by : this.members.has(item.uid) ? item.uid : null,
      item: {
        uid: item.uid,
        meta: item.meta,
        title: item.title,
        subtitle: item.subtitle,
        poster: item.poster,
        streamKey: item.streamKey,
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
      host: this.host,
      item: {
        // Same addons as whoever started this one, same ranking.
        uid: media.startedByUid || this.host,
        meta: { id: media.meta?.id, type: media.meta?.type, videoId: next.videoId },
        title: media.title,
        subtitle: next.subtitle,
        poster: media.poster,
        streamKey: null,
      },
    });
  }

  /** Cancels a countdown: "autostart" (anyone) or "autonext" (whoever controls). */
  cancel(uid, what) {
    if (!this.members.has(uid)) return false;
    if (what === 'autostart' && this.autostart) {
      const item = this.queue.get(this.autostart.itemId);
      this.autostartSuppressed = item ? { itemId: item.id, count: this.#presentVotes(item.votes) } : null;
      this.autostart = null;
      this.#notice(`${this.#name(uid)} a annulé le lancement automatique`, { except: uid });
      return this.#changed();
    }
    if (what === 'autonext' && this.autonext && this.canControl(uid)) {
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

  /** Deadlines: load/stall waits, requests, votes, countdowns. Returns true if state changed. */
  tick() {
    const t = this.now();
    let changed = false;
    for (const [uid, deadline] of this.waiting) {
      if (deadline <= t) {
        if (!changed) this.#settle();
        this.waiting.delete(uid);
        changed = true;
      }
    }
    for (const [id, r] of this.requests) {
      if (r.expires <= t) {
        this.requests.delete(id);
        this.#notice(`La demande de ${this.#name(r.uid)} a expiré`, { to: r.uid });
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
      members: [...this.members.values()].map(({ uid, name, avatar, quality, presence }) => ({
        uid,
        name,
        avatar,
        quality,
        state: this.waiting.has(uid) ? 'loading' : this.media ? presence : 'browsing',
      })),
      control: this.control,
      host: this.host,
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
      requests: [...this.requests.values()].map(({ id, uid, kind, position, expires }) => ({
        id,
        uid,
        name: this.#name(uid),
        kind,
        position,
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

  get(id) {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id, this.options);
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
