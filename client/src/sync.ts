// Pure playback-sync helpers (unit tested in sync.test.ts).

export interface RoomTiming {
  running: boolean;
  position: number; // seconds, as of serverTime
  serverTime: number; // ms, server clock
  duration?: number | null;
}

/** Estimates the server clock from ping/pong round trips (keeps the lowest-latency samples). */
export class ServerClock {
  private samples: { offset: number; rtt: number }[] = [];

  add(clientSent: number, serverTime: number, clientReceived: number) {
    const rtt = clientReceived - clientSent;
    if (rtt < 0 || rtt > 10_000) return;
    this.samples.push({ offset: serverTime - (clientSent + clientReceived) / 2, rtt });
    if (this.samples.length > 10) this.samples.shift();
  }

  get ready() {
    return this.samples.length > 0;
  }

  /** server time − client time, in ms */
  get offset() {
    if (!this.samples.length) return 0;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    return best.reduce((sum, s) => sum + s.offset, 0) / best.length;
  }

  now(clientNow = Date.now()) {
    return clientNow + this.offset;
  }
}

export function expectedPosition(t: RoomTiming, serverNow: number) {
  const pos = t.running ? t.position + (serverNow - t.serverTime) / 1000 : t.position;
  return t.duration ? Math.min(Math.max(0, pos), t.duration) : Math.max(0, pos);
}

/**
 * Arriving while the film runs: jump to the live? Jumping outside what is loaded means
 * waiting again (about as long as the first load, the live moving on meanwhile): only
 * when far behind it (more than `behindS`, where "Revenir au direct" would show).
 */
export function joinLiveJump(gap: number, loadedAtTarget: boolean, behindS: number) {
  return gap > 1.5 && (loadedAtTarget || gap > behindS);
}

/** Wait before the n-th automatic reload of a stream that shows nothing (0 = first). */
export function loadRetryWait(retries: number, firstMs = 30_000, maxMs = 4 * 60_000) {
  return Math.min(firstMs * 2 ** Math.max(0, retries), maxMs);
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
