// Pure helpers (no DOM): routes, progress, source ranking. Tested in format.test.ts.

export interface Route {
  name: 'home' | 'discover' | 'library' | 'history' | 'settings' | 'detail' | 'search' | 'player' | 'notfound';
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
  if (!parts.length) return { name: 'home', params };
  const name = SIMPLE.find((n) => n === parts[0]);
  // Unknown page (old or mistyped link): the shell shows a "page introuvable" state.
  return { name: name || 'notfound', params };
}

export function routeHref(name: Route['name'], params: Record<string, string | null | undefined> = {}): string {
  // type/id are path parts of a title page only; elsewhere (Discover, Bibliothèque,
  // Recherche) "type" is an ordinary filter and must stay in the query.
  const { type, id, ...others } = params;
  const rest = name === 'detail' ? others : params;
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
  languages?: string[];
}

const QUALITY_RANK: Record<string, number> = { '4K': 1, '1080p': 3, '720p': 2 };

/**
 * Source for the one-click "Regarder ensemble": MULTI first (VF and VO in one file, so
 * each viewer picks their language), then débrid-cached (instant, no P2P), then 1080p
 * over 4K/720p (lighter for the server, fine for most), then most seeders.
 */
export function pickBest<T extends Rankable>(list: T[]): T | null {
  let best: T | null = null;
  const score = (s: T) => [s.languages?.includes('MULTI') ? 1 : 0, s.cached ? 1 : 0, QUALITY_RANK[s.quality || ''] || 0, s.seeders ?? -1];
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

// ---------------------------------------------------------------- languages & subtitles

const LANGS: Record<string, string> = {
  fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien', pt: 'Portugais', pb: 'Portugais (BR)',
  nl: 'Néerlandais', ar: 'Arabe', tr: 'Turc', ru: 'Russe', pl: 'Polonais', ja: 'Japonais', ko: 'Coréen', zh: 'Chinois',
  el: 'Grec', he: 'Hébreu', ro: 'Roumain', sv: 'Suédois', da: 'Danois', no: 'Norvégien', fi: 'Finnois', cs: 'Tchèque',
  hr: 'Croate', sl: 'Slovène', hu: 'Hongrois', bg: 'Bulgare', sr: 'Serbe', uk: 'Ukrainien', vi: 'Vietnamien',
  th: 'Thaï', id: 'Indonésien', fa: 'Persan', hi: 'Hindi',
};
// ISO 639-2 (OpenSubtitles, file tags) → 639-1.
const THREE: Record<string, string> = {
  fre: 'fr', fra: 'fr', eng: 'en', spa: 'es', ger: 'de', deu: 'de', ita: 'it', por: 'pt', pob: 'pb', dut: 'nl', nld: 'nl',
  ara: 'ar', tur: 'tr', rus: 'ru', pol: 'pl', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ell: 'el', gre: 'el', heb: 'he',
  ron: 'ro', rum: 'ro', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', cze: 'cs', ces: 'cs', hrv: 'hr', slv: 'sl', hun: 'hu',
  bul: 'bg', srp: 'sr', scc: 'sr', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id', per: 'fa', fas: 'fa', hin: 'hi',
};

/** "fre" / "fra" / "fr" / "fr-FR" → "fr"; unknown codes are kept lower-cased. */
export function langCode(code: string | null | undefined) {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  return THREE[c] || c;
}

export function languageName(code: string | null | undefined) {
  const c = langCode(code);
  return LANGS[c] || (c ? c.toUpperCase() : 'Inconnu');
}

export interface TimedCue {
  start: number;
  end: number;
  text: string;
}

/** Cues showing at time t (sorted by start; binary search, then scan back for overlaps). */
export function activeCues(cues: TimedCue[], t: number): TimedCue[] {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: TimedCue[] = [];
  // Cues rarely last more than ~10 s: look back a bounded number of entries.
  for (let i = lo - 1; i >= 0 && i >= lo - 20; i--) if (cues[i].end > t) out.unshift(cues[i]);
  return out;
}

export interface AudioTrackLike {
  lang?: string;
  name?: string;
}

/**
 * Track for this viewer's audio preference: "fr" → the French track, "vo" → the
 * first non-French one (the original). null when nothing matches or no preference.
 */
export function pickAudioTrack(tracks: AudioTrackLike[], pref: string | null): number | null {
  if (!pref || tracks.length < 2) return null;
  const isFrench = (t: AudioTrackLike) => langCode(t.lang) === 'fr' || /fran[cç]ais|french|\bvf/i.test(t.name || '');
  const i = pref === 'fr' ? tracks.findIndex(isFrench) : tracks.findIndex((t) => !isFrench(t));
  return i >= 0 ? i : null;
}
