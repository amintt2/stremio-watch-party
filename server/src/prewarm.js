// Starting before the click, like Huwa: when a film's page (or an episode) shows its sources,
// the client asks the server to race them and to open the winner right away (torrent
// metadata, file analysis). "Lire" then finds the work done and the film starts at once.
// A start with the same sources reuses (and consumes) it; unused ones expire.

export const PREWARM_TTL_MS = 3 * 60_000;
const MAX_ENTRIES = 40;

export class Prewarms {
  /**
   * race(keys, opts) → Promise<{ streams, pick }> (the server's automatic choice);
   * open(stream) → Promise<session> (opens the source: torrent + analysis).
   */
  constructor({ race, open, ttlMs = PREWARM_TTL_MS, now = Date.now }) {
    this.race = race;
    this.open = open;
    this.ttlMs = ttlMs;
    this.now = now;
    /** key → { at, result, opened } */
    this.entries = new Map();
  }

  static key(keys, want) {
    return `${want || ''}|${[...keys].sort().join(',')}`;
  }

  #sweep() {
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.at > this.ttlMs) this.entries.delete(k);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
  }

  #make(keys, opts) {
    const result = this.race(keys, opts);
    // Opening the winner starts as soon as the race is over.
    const opened = result.then(({ streams }) => (streams[0] ? this.open(streams[0]) : null));
    // Nobody may ever ask for it: no unhandled rejection.
    result.catch(() => {});
    opened.catch(() => {});
    return { at: this.now(), result, opened };
  }

  /** From the page: prepares these sources (once; the same ones again reuse it). */
  start(keys, opts) {
    this.#sweep();
    const k = Prewarms.key(keys, opts.want);
    if (this.entries.has(k)) return this.entries.get(k);
    const entry = this.#make(keys, opts);
    this.entries.set(k, entry);
    // A failed preparation is not kept: "Lire" tries again instead of getting the failure.
    entry.result.then(
      ({ streams }) => !streams.length && this.entries.get(k) === entry && this.entries.delete(k),
      () => this.entries.get(k) === entry && this.entries.delete(k)
    );
    entry.opened.catch(() => this.entries.get(k) === entry && this.entries.delete(k));
    return entry;
  }

  /** From "Lire": the prepared start for these sources (consumed), else one made now. */
  take(keys, opts) {
    this.#sweep();
    const k = Prewarms.key(keys, opts.want);
    const entry = this.entries.get(k);
    if (entry) {
      this.entries.delete(k);
      return { ...entry, reused: true };
    }
    return { ...this.#make(keys, opts), reused: false };
  }
}
