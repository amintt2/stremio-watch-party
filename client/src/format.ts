// Pure helpers (no DOM): routes, progress, source ranking. Tested in format.test.ts.

export interface Route {
  name: 'home' | 'discover' | 'library' | 'history' | 'settings' | 'detail' | 'search' | 'player';
  params: Record<string, string>;
}

const SIMPLE = ['home', 'discover', 'library', 'history', 'settings', 'search', 'player'] as const;

/** "#/detail/series/tt1?video=tt1:1:2" → { name: 'detail', params: { type, id, video } } */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params: Record<string, string> = Object.fromEntries(new URLSearchParams(query));
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts[0] === 'detail' && (parts[1] === 'movie' || parts[1] === 'series') && parts[2]) {
    return { name: 'detail', params: { ...params, type: parts[1], id: parts[2] } };
  }
  const name = SIMPLE.find((n) => n === parts[0]);
  return { name: name || 'home', params };
}

export function routeHref(name: Route['name'], params: Record<string, string | null | undefined> = {}): string {
  const { type, id, ...rest } = params;
  const path = name === 'detail' ? `detail/${type}/${encodeURIComponent(id || '')}` : name === 'home' ? '' : name;
  const query = new URLSearchParams(
    Object.entries(rest).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
  ).toString();
  return `#/${path}${query ? `?${query}` : ''}`;
}

/** 0..1, or 0 without a duration. */
export function progressRatio(position: number, duration: number | null | undefined) {
  if (!duration || duration <= 0) return 0;
  return Math.max(0, Math.min(1, position / duration));
}

/** Same thresholds as the server (db.js). */
export const WATCHED_RATIO = 0.9;
export const MIN_RESUME_S = 15;

export function canResume(p: { position: number; duration: number | null } | null | undefined) {
  if (!p || p.position < MIN_RESUME_S) return false;
  return progressRatio(p.position, p.duration) < WATCHED_RATIO;
}

export function episodeCode(season: number, episode: number) {
  return `S${season}E${String(episode).padStart(2, '0')}`;
}

/** "il y a 5 min", "hier", "le 12/03" */
export function relativeTime(ts: number, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return 'hier';
  if (s < 7 * 86400) return `il y a ${Math.floor(s / 86400)} jours`;
  const d = new Date(ts);
  return `le ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export interface Rankable {
  cached: boolean;
  seeders: number | null;
  quality: string | null;
}

const QUALITY_RANK: Record<string, number> = { '4K': 1, '1080p': 3, '720p': 2 };

/**
 * Source for the one-click "Regarder ensemble": débrid-cached first (instant, no P2P),
 * then 1080p over 4K/720p (lighter for the server, fine for most), then most seeders.
 */
export function pickBest<T extends Rankable>(list: T[]): T | null {
  let best: T | null = null;
  const score = (s: T) => [s.cached ? 1 : 0, QUALITY_RANK[s.quality || ''] || 0, s.seeders ?? -1];
  for (const s of list) {
    if (!best) {
      best = s;
      continue;
    }
    const a = score(s);
    const b = score(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (a[i] > b[i]) best = s;
        break;
      }
    }
  }
  return best;
}
