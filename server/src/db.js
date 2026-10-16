// Per-user data: accounts (= Discord identities), watch progress, library, personal
// stream addons. One SQLite file under DATA_DIR, through Node's built-in node:sqlite
// (no native module to build on Alpine).
//
// Every query takes the user id from the verified session: nothing here trusts a
// user id coming from the browser.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Above this share of the duration, a video counts as watched. */
export const WATCHED_RATIO = 0.9;
/** Below this position (s), a video isn't worth resuming. */
export const MIN_RESUME_S = 15;

// Each entry runs once, in order; PRAGMA user_version remembers how far we got.
const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     avatar TEXT,
     guest INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     seen_at INTEGER NOT NULL
   );
   CREATE TABLE progress (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     video_id TEXT NOT NULL,
     meta_id TEXT NOT NULL,
     meta_type TEXT NOT NULL,
     name TEXT NOT NULL,
     poster TEXT,
     episode TEXT,
     position REAL NOT NULL,
     duration REAL,
     watched INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, video_id)
   );
   CREATE INDEX progress_recent ON progress (user_id, updated_at DESC);
   CREATE INDEX progress_meta ON progress (user_id, meta_id);
   CREATE TABLE library (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     meta_id TEXT NOT NULL,
     meta_type TEXT NOT NULL,
     name TEXT NOT NULL,
     poster TEXT,
     year TEXT,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, meta_id)
   );
   CREATE TABLE addons (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     url TEXT NOT NULL,
     name TEXT NOT NULL,
     added_at INTEGER NOT NULL
   );
   CREATE INDEX addons_user ON addons (user_id);`,
];

const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

export function openStore(dir, { now = Date.now } = {}) {
  let path = ':memory:';
  if (dir !== ':memory:') {
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'watch-party.db');
  }
  return new Store(new DatabaseSync(path), now);
}

export class Store {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  /** Idempotent: safe to run at every startup. */
  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- users

  /** Creates the account on first login, refreshes name/avatar afterwards. */
  upsertUser({ uid, name, avatar, guest = false }) {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO users (id, name, avatar, guest, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, seen_at = excluded.seen_at`
      )
      .run(String(uid), str(name, 64) || '?', str(avatar, 300), guest ? 1 : 0, t, t);
  }

  getUser(uid) {
    const row = this.db.prepare('SELECT id, name, avatar, guest, created_at FROM users WHERE id = ?').get(String(uid));
    return row ? { uid: row.id, name: row.name, avatar: row.avatar, guest: !!row.guest, createdAt: row.created_at } : null;
  }

  // ---------------------------------------------------------------- progress / history

  /**
   * Saves where this user is in a video. `watched` sticks once reached, so a rewatch
   * keeps the mark while its position is still tracked for "continue".
   */
  saveProgress(uid, { videoId, metaId, metaType, name, poster, episode, position, duration }) {
    const pos = Number(position);
    const dur = Number(duration) > 0 ? Number(duration) : null;
    if (!str(videoId, 200) || !str(metaId, 200) || !Number.isFinite(pos) || pos < 0) return false;
    const watched = dur && pos >= dur * WATCHED_RATIO ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO progress (user_id, video_id, meta_id, meta_type, name, poster, episode, position, duration, watched, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, video_id) DO UPDATE SET
           name = excluded.name, poster = excluded.poster, episode = excluded.episode,
           position = excluded.position, duration = COALESCE(excluded.duration, duration),
           watched = MAX(watched, excluded.watched), updated_at = excluded.updated_at`
      )
      .run(
        String(uid),
        videoId.slice(0, 200),
        metaId.slice(0, 200),
        metaType === 'series' ? 'series' : 'movie',
        str(name, 200) || '?',
        str(poster, 500),
        str(episode, 200),
        dur ? Math.min(pos, dur) : pos,
        dur,
        watched,
        this.now()
      );
    return true;
  }

  /** Per-video progress of one title (episode marks on the detail page). */
  progressFor(uid, metaId) {
    return this.db
      .prepare('SELECT * FROM progress WHERE user_id = ? AND meta_id = ? ORDER BY updated_at DESC')
      .all(String(uid), String(metaId))
      .map(toProgress);
  }

  /** Latest video per title, most recent first. */
  history(uid, limit = 100) {
    return this.db
      .prepare(
        `SELECT * FROM progress p WHERE user_id = ? AND updated_at = (
           SELECT MAX(updated_at) FROM progress q WHERE q.user_id = p.user_id AND q.meta_id = p.meta_id)
         GROUP BY meta_id ORDER BY updated_at DESC LIMIT ?`
      )
      .all(String(uid), limit)
      .map(toProgress);
  }

  /** Titles whose latest video was started but not finished. */
  continueWatching(uid, limit = 20) {
    return this.history(uid, 200)
      .filter((p) => p.position >= MIN_RESUME_S && !(p.duration && p.position >= p.duration * WATCHED_RATIO))
      .slice(0, limit);
  }

  removeHistory(uid, metaId) {
    return this.db.prepare('DELETE FROM progress WHERE user_id = ? AND meta_id = ?').run(String(uid), String(metaId)).changes > 0;
  }

  // ---------------------------------------------------------------- library

  addToLibrary(uid, { metaId, metaType, name, poster, year }) {
    if (!str(metaId, 200)) return false;
    this.db
      .prepare(
        `INSERT INTO library (user_id, meta_id, meta_type, name, poster, year, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, meta_id) DO UPDATE SET name = excluded.name, poster = excluded.poster, year = excluded.year`
      )
      .run(String(uid), metaId.slice(0, 200), metaType === 'series' ? 'series' : 'movie', str(name, 200) || '?', str(poster, 500), str(year, 16), this.now());
    return true;
  }

  removeFromLibrary(uid, metaId) {
    return this.db.prepare('DELETE FROM library WHERE user_id = ? AND meta_id = ?').run(String(uid), String(metaId)).changes > 0;
  }

  inLibrary(uid, metaId) {
    return !!this.db.prepare('SELECT 1 FROM library WHERE user_id = ? AND meta_id = ?').get(String(uid), String(metaId));
  }

  /** @param {{ type?: 'movie'|'series', sort?: 'recent'|'name' }} opts */
  library(uid, { type, sort = 'recent' } = {}) {
    const order = sort === 'name' ? 'name COLLATE NOCASE ASC' : 'added_at DESC';
    const rows =
      type === 'movie' || type === 'series'
        ? this.db.prepare(`SELECT * FROM library WHERE user_id = ? AND meta_type = ? ORDER BY ${order}`).all(String(uid), type)
        : this.db.prepare(`SELECT * FROM library WHERE user_id = ? ORDER BY ${order}`).all(String(uid));
    return rows.map((r) => ({ id: r.meta_id, type: r.meta_type, name: r.name, poster: r.poster, year: r.year, addedAt: r.added_at }));
  }

  // ---------------------------------------------------------------- personal stream addons

  /** Full URLs: server-side use only. */
  addonUrls(uid) {
    return this.db.prepare('SELECT url FROM addons WHERE user_id = ? ORDER BY added_at').all(String(uid)).map((r) => r.url);
  }

  addAddon(uid, url, name) {
    const id = randomBytes(9).toString('base64url');
    this.db
      .prepare('INSERT INTO addons (id, user_id, url, name, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, String(uid), String(url).slice(0, 2000), str(name, 100) || '?', this.now());
    return id;
  }

  removeAddon(uid, id) {
    return this.db.prepare('DELETE FROM addons WHERE user_id = ? AND id = ?').run(String(uid), String(id)).changes > 0;
  }

  /** What the browser may see: name, host and a masked URL, never the secret part. */
  listAddons(uid) {
    return this.db
      .prepare('SELECT id, url, name, added_at FROM addons WHERE user_id = ? ORDER BY added_at')
      .all(String(uid))
      .map((r) => ({ id: r.id, name: r.name, url: maskUrl(r.url), addedAt: r.added_at }));
  }
}

function toProgress(r) {
  return {
    videoId: r.video_id,
    metaId: r.meta_id,
    type: r.meta_type,
    name: r.name,
    poster: r.poster,
    episode: r.episode,
    position: r.position,
    duration: r.duration,
    watched: !!r.watched,
    updatedAt: r.updated_at,
  };
}

/** "https://torrentio.strem.fun/realdebrid=abc123/manifest.json" → "https://torrentio.strem.fun/••••/manifest.json" */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    const hidden = u.pathname.replace(/\/manifest\.json$/, '').replace(/^\/+/, '') || u.search;
    return `${u.protocol}//${u.host}/${hidden ? '••••/' : ''}manifest.json`;
  } catch {
    return '••••';
  }
}
