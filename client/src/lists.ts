// Pure helpers (no DOM) for the catalogue pages: library sort/search, search results,
// Discover filters, episode picking. Tested in lists.test.ts.

// ---------------------------------------------------------------- text

/** Lowercase, no accents: "Amélie" matches "amelie". */
export function fold(text: string) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const num = (v: string | number | null | undefined) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/** null/NaN last, whatever the direction. */
function byNumberDesc<T>(get: (x: T) => number | null) {
  return (a: T, b: T) => {
    const x = get(a);
    const y = get(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return y - x;
  };
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });

// ---------------------------------------------------------------- library

export type LibrarySort = 'recent' | 'watched' | 'name' | 'year' | 'rating';
export const LIBRARY_SORTS: [LibrarySort, string][] = [
  ['recent', 'Ajout récent'],
  ['watched', 'Dernière lecture'],
  ['name', 'A → Z'],
  ['year', 'Année'],
  ['rating', 'Note'],
];

export interface LibraryEntry {
  id: string;
  type: 'movie' | 'series';
  name: string;
  year: string | null;
  rating?: string | null;
  addedAt: number;
  lastWatchedAt?: number | null;
}

export function parseLibrarySort(v: string | undefined): LibrarySort {
  return LIBRARY_SORTS.some(([s]) => s === v) ? (v as LibrarySort) : 'recent';
}

export function matchesQuery(name: string, q: string) {
  const f = fold(q);
  return !f || fold(name).includes(f);
}

/** Filtered by type and text, then sorted; the input array is left as is. */
export function sortLibrary<T extends LibraryEntry>(items: T[], opts: { type?: string; sort?: LibrarySort; q?: string }) {
  const list = items.filter((i) => (!opts.type || i.type === opts.type) && matchesQuery(i.name, opts.q || ''));
  switch (opts.sort) {
    case 'name':
      return list.sort(byName);
    case 'year':
      return list.sort((a, b) => byNumberDesc<T>((x) => num(x.year))(a, b) || byName(a, b));
    case 'rating':
      return list.sort((a, b) => byNumberDesc<T>((x) => num(x.rating))(a, b) || byName(a, b));
    case 'watched':
      // Never watched: after, by date added.
      return list.sort((a, b) => byNumberDesc<T>((x) => x.lastWatchedAt ?? null)(a, b) || b.addedAt - a.addedAt);
    default:
      return list.sort((a, b) => b.addedAt - a.addedAt);
  }
}

/** Counts for the "Tout · Films · Séries" filter, with the text search applied. */
export function typeCounts(items: { type: string; name: string }[], q = '') {
  const shown = items.filter((i) => matchesQuery(i.name, q));
  return {
    all: shown.length,
    movie: shown.filter((i) => i.type === 'movie').length,
    series: shown.filter((i) => i.type === 'series').length,
  };
}

// ---------------------------------------------------------------- search results

export type ResultSort = 'relevance' | 'year' | 'rating';
export const RESULT_SORTS: [ResultSort, string][] = [
  ['relevance', 'Pertinence'],
  ['year', 'Année'],
  ['rating', 'Note'],
];

export function parseResultSort(v: string | undefined): ResultSort {
  return RESULT_SORTS.some(([s]) => s === v) ? (v as ResultSort) : 'relevance';
}

/** Relevance keeps the addon's order. */
export function sortResults<T extends { type: string; year: string | null; rating?: string | null }>(items: T[], opts: { type?: string; sort?: ResultSort }) {
  const list = items.filter((i) => !opts.type || i.type === opts.type);
  if (opts.sort === 'year') return list.sort(byNumberDesc<T>((x) => num(x.year)));
  if (opts.sort === 'rating') return list.sort(byNumberDesc<T>((x) => num(x.rating)));
  return list;
}

// ---------------------------------------------------------------- discover

export interface CatalogLike {
  type: string;
  id: string;
  name: string;
  genres: string[];
  genreRequired: boolean;
}

/** The genre list of Cinemeta's "New" catalog is years. */
export function isYearList(genres: string[]) {
  return genres.length > 0 && genres.every((g) => /^\d{4}$/.test(g));
}

/** Label of a catalog as a sort ("Trier par"). */
export function sortLabel(c: CatalogLike) {
  if (c.id === 'top' || c.name === 'Popular') return 'Popularité';
  if (c.id === 'imdbRating' || c.name === 'Featured') return 'Note';
  if (c.id === 'year' || c.name === 'New' || isYearList(c.genres)) return 'Année';
  return c.name;
}

export interface DiscoverState<C extends CatalogLike> {
  type: 'movie' | 'series';
  catalog: C | null;
  /** Genre (or year, for a year catalog) actually used; '' = all. */
  genre: string;
  /** The catalog's genres are years. */
  byYear: boolean;
  /** Another catalog of this type listing years (for the year filter), if any. */
  yearCatalog: C | null;
}

/** URL params → what Discover shows; unknown values fall back to the defaults. */
export function discoverState<C extends CatalogLike>(catalogs: C[], params: Record<string, string>): DiscoverState<C> {
  const type = params.type === 'series' ? 'series' : 'movie';
  const ofType = catalogs.filter((c) => c.type === type);
  const catalog = ofType.find((c) => c.id === params.catalog) || ofType[0] || null;
  const yearCatalog = ofType.find((c) => isYearList(c.genres)) || null;
  if (!catalog) return { type, catalog: null, genre: '', byYear: false, yearCatalog };
  const genre = catalog.genres.includes(params.genre) ? params.genre : catalog.genreRequired ? catalog.genres[0] || '' : '';
  return { type, catalog, genre, byYear: isYearList(catalog.genres), yearCatalog: yearCatalog === catalog ? null : yearCatalog };
}

// ---------------------------------------------------------------- episodes

export interface EpisodeLike {
  id: string;
  season: number;
  episode: number;
  released: string | null;
}

export interface ProgressLike {
  videoId: string;
  position: number;
  duration: number | null;
  watched: boolean;
  updatedAt: number;
}

/** Not out yet (no date counts as released: addons often omit it). */
export function isUpcoming(v: { released: string | null }, now = Date.now()) {
  if (!v.released) return false;
  const t = Date.parse(v.released);
  return Number.isFinite(t) && t > now;
}

/** Next episode in watching order (bonus season 0 excluded), or null. */
export function nextEpisode<T extends EpisodeLike>(videos: T[], current: T | null) {
  if (!current) return null;
  const regular = videos.filter((v) => v.season > 0);
  const i = regular.findIndex((v) => v.id === current.id);
  return i >= 0 ? regular[i + 1] || null : null;
}

/**
 * Episode a series page opens on: the one asked in the URL, else the last one started
 * and not finished, else the one after the last watched, else the first released one.
 */
export function defaultEpisode<T extends EpisodeLike>(videos: T[], progress: ProgressLike[], wanted?: string, now = Date.now()): T | null {
  if (!videos.length) return null;
  const asked = wanted && videos.find((v) => v.id === wanted);
  if (asked) return asked;
  const latest = [...progress].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const latestVideo = latest && videos.find((v) => v.id === latest.videoId);
  if (latestVideo) {
    if (!latest.watched) return latestVideo;
    const next = nextEpisode(videos, latestVideo);
    if (next && !isUpcoming(next, now)) return next;
    return latestVideo;
  }
  return videos.find((v) => v.season > 0 && !isUpcoming(v, now)) || videos.find((v) => v.season > 0) || videos[0];
}
