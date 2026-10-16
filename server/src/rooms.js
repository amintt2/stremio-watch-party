// Server-authoritative playback state for one Activity instance.
//
// The room stores the position at `updatedAt`. While it is running (not paused
// and nobody is being waited for), the current position is extrapolated from the
// clock. Viewers that stall are put in `waiting`: the room freezes until they are
// ready again, or until WAIT_TIMEOUT_MS passes (then they catch up on their own).

export const WAIT_TIMEOUT_MS = 10_000;
export const LOAD_TIMEOUT_MS = 20_000;

export class Room {
  constructor(id, { now = Date.now } = {}) {
    this.id = id;
    this.now = now;
    this.members = new Map(); // uid -> { uid, name, avatar, connections, quality }
    this.waiting = new Map(); // uid -> deadline (ms)
    this.media = null;
    this.paused = true;
    this.position = 0;
    this.updatedAt = now();
    this.rev = 0;
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

  join({ uid, name, avatar }) {
    const existing = this.members.get(uid);
    if (existing) {
      existing.connections++;
      return false;
    }
    this.members.set(uid, { uid, name, avatar, connections: 1, quality: null });
    return this.#changed();
  }

  leave(uid) {
    const m = this.members.get(uid);
    if (!m) return false;
    if (--m.connections > 0) return false;
    this.#settle();
    this.members.delete(uid);
    this.waiting.delete(uid);
    return this.#changed();
  }

  get empty() {
    return this.members.size === 0;
  }

  /** New media: everyone currently here loads it, playback starts when all are ready. */
  load(media, { startAt = 0 } = {}) {
    this.media = media;
    this.paused = false;
    this.position = this.#clamp(startAt);
    this.updatedAt = this.now();
    this.waiting.clear();
    const deadline = this.now() + LOAD_TIMEOUT_MS;
    for (const uid of this.members.keys()) this.waiting.set(uid, deadline);
    return this.#changed();
  }

  stop() {
    this.media = null;
    this.paused = true;
    this.position = 0;
    this.waiting.clear();
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

  /** Gives up on viewers that took too long. Returns true if state changed. */
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
    return changed ? this.#changed() : false;
  }

  snapshot() {
    const t = this.now();
    return {
      rev: this.rev,
      serverTime: t,
      media: this.media,
      paused: this.paused,
      running: this.running,
      position: this.currentPosition(t),
      waiting: [...this.waiting.keys()],
      members: [...this.members.values()].map(({ uid, name, avatar, quality }) => ({
        uid,
        name,
        avatar,
        quality,
      })),
    };
  }
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

  [Symbol.iterator]() {
    return this.rooms.values();
  }
}
