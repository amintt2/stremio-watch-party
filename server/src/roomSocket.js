// Room socket messages: validation, rate limiting and dispatch to the Room (pure, tested).

const ID_RE = /^[a-z0-9]{1,12}$/;
const UID_RE = /^[\w:.-]{1,200}$/;

/** Sliding-window limiter: at most `max` hits per `windowMs` for one key. */
export class RateLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  allow(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value);
    return true;
  }
}

/** Messages of the social layer (votes, queue, host...), rate-limited per person. */
export const SOCIAL_MESSAGES = new Set([
  'presence',
  'vote',
  'withdraw',
  'start',
  'cancel',
  'mode',
  'host',
  'request',
  'respond',
  'cancelRequest',
  'voteAction',
  'admit',
  'refuse',
  'autoAdmit',
  'kick',
  'copilot',
]);

const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isUid = (v) => typeof v === 'string' && UID_RE.test(v);
const isPosition = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6;

/**
 * Applies one socket message from `uid` to the room. Returns true when the room
 * changed (broadcast needed), false when the message was invalid or had no effect.
 */
export function handleRoomMessage(room, uid, msg) {
  switch (msg?.t) {
    case 'play':
    case 'pause':
      return room.act(uid, msg.t);
    case 'seek':
      return isPosition(msg.position) ? room.act(uid, 'seek', msg.position) : false;
    case 'buffering':
      return room.setBuffering(uid, !!msg.value);
    case 'external':
      return typeof msg.value === 'boolean' ? room.setExternal(uid, msg.value) : false;
    case 'quality':
      return typeof msg.value === 'string' ? room.setQuality(uid, msg.value) : false;
    case 'presence':
      return room.setPresence(uid, msg.value);
    case 'vote':
      return isId(msg.id) ? room.vote(uid, msg.id) : false;
    case 'withdraw':
      return isId(msg.id) ? room.withdraw(uid, msg.id) : false;
    case 'start':
      return isId(msg.id) ? room.startSuggestion(uid, msg.id) : false;
    case 'cancel':
      return ['autostart', 'autonext'].includes(msg.what) ? room.cancel(uid, msg.what) : false;
    case 'mode':
      return room.setControl(uid, msg.value);
    case 'host':
      return isUid(msg.uid) ? room.handOver(uid, msg.uid) : false;
    case 'copilot':
      return isUid(msg.uid) && typeof msg.value === 'boolean' ? room.setCopilot(uid, msg.uid, msg.value) : false;
    case 'kick':
      return isUid(msg.uid) ? room.kick(uid, msg.uid) : false;
    case 'admit':
      return isUid(msg.uid) ? room.admit(uid, msg.uid) : false;
    case 'refuse':
      return isUid(msg.uid) ? room.refuse(uid, msg.uid) : false;
    case 'autoAdmit':
      return typeof msg.value === 'boolean' ? room.setAutoAdmit(uid, msg.value) : false;
    case 'request':
      if (msg.kind === 'seek') return isPosition(msg.position) ? room.request(uid, 'seek', msg.position) : false;
      if (msg.kind === 'start') return isId(msg.id) ? room.request(uid, 'start', msg.id) : false;
      if (msg.kind === 'play' || msg.kind === 'pause') return room.request(uid, msg.kind);
      return false;
    case 'respond':
      return isId(msg.id) ? room.respond(uid, msg.id, msg.accept === true) : false;
    case 'cancelRequest':
      return isId(msg.id) ? room.cancelRequest(uid, msg.id) : false;
    case 'voteAction':
      return room.voteAction(uid, msg.kind);
    default:
      return false;
  }
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Validates a suggestion body (POST /api/room/propose). Returns null when invalid. */
export function cleanProposal(body) {
  const meta = body?.meta;
  if (!meta || typeof meta !== 'object' || !['movie', 'series'].includes(meta.type)) return null;
  const id = str(meta.id, 200);
  const videoId = str(meta.videoId, 200) || id;
  const title = str(body.title, 200);
  if (!id || !title) return null;
  const poster = str(body.poster, 500);
  return {
    meta: { id, type: meta.type, videoId },
    title,
    subtitle: str(body.subtitle, 200) || '',
    poster: poster && /^https?:\/\//.test(poster) ? poster : null,
    streamKey: str(body.streamKey, 64),
  };
}
