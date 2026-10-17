export interface Quality {
  id: string;
  label: string;
  maxWidth: number;
  estBitrate: number;
}

export interface RoomMedia {
  sid: string;
  title: string;
  subtitle: string;
  poster: string | null;
  duration: number | null;
  startedBy: string;
  meta: { id: string; type: 'movie' | 'series'; videoId: string } | null;
  source: { codec: string; width: number; height: number; hdr: boolean; dolbyVision: boolean };
  qualities: Quality[];
  /** Next episode (series), for the auto-next countdown. */
  next?: { videoId: string; subtitle: string } | null;
}

export interface Member {
  uid: string;
  name: string;
  avatar: string | null;
  quality: string | null;
  /** loading (load barrier / stall), watching, browsing (player minimised). */
  state?: 'loading' | 'watching' | 'browsing';
  /** Watches in an external player (VLC...): the room doesn't wait for them. */
  external?: boolean;
}

/** A suggestion in the room queue (no stream URL/key: only a label). */
export interface QueueItem {
  id: string;
  uid: string;
  name: string;
  title: string;
  subtitle: string;
  poster: string | null;
  meta: { id: string; type: MetaType; videoId: string };
  source: string | null;
  votes: string[];
  createdAt: number;
}

export interface ControlRequest {
  id: string;
  uid: string;
  name: string;
  kind: 'play' | 'pause' | 'seek' | 'start';
  position: number | null;
  /** Suggestion asked to start (kind "start"). */
  itemId: string | null;
  /** "une pause", "d’aller à 42:10", "de lancer « Dune »" */
  label: string;
  /** server time (ms) */
  expires: number;
}

export interface ActionVote {
  kind: 'pause' | 'skip';
  voters: string[];
  expires: number;
}

export interface RoomState {
  rev: number;
  serverTime: number;
  media: RoomMedia | null;
  paused: boolean;
  running: boolean;
  position: number;
  waiting: string[];
  members: Member[];
  // Social layer (see room.ts).
  ended?: boolean;
  /** "host": only the host and co-pilotes control (default); "all": everyone. */
  control?: 'all' | 'host';
  host?: string | null;
  copilots?: string[];
  /** Website rooms: newcomers wait until a host/co-pilote lets them in. */
  lobby?: boolean;
  autoAdmit?: boolean;
  pending?: { uid: string; name: string; avatar: string | null; since: number }[];
  /** Muted for spamming. */
  muted?: string[];
  queue?: QueueItem[];
  autostart?: { itemId: string; at: number } | null;
  autonext?: { at: number; subtitle: string } | null;
  starting?: { title: string; by: string | null } | null;
  requests?: ControlRequest[];
  votes?: ActionVote[];
}

export interface User {
  uid: string;
  name: string;
  avatar: string | null;
  guest?: boolean;
}

/** Room outside Discord: personal room code, or one joined with a code/link. */
export interface RoomInfo {
  code: string;
  personal: boolean;
  /** The Discord Activity's room, continued on the site ("Ouvrir sur le site"). */
  activity?: boolean;
}

export type MetaType = 'movie' | 'series';

export interface SearchResult {
  id: string;
  type: MetaType;
  name: string;
  poster: string | null;
  year: string | null;
  rating?: string | null;
}

export interface Video {
  id: string;
  season: number;
  episode: number;
  title: string;
  released: string | null;
  thumbnail: string | null;
  overview: string | null;
}

export interface Meta extends SearchResult {
  background: string | null;
  logo: string | null;
  description: string;
  releaseInfo: string | null;
  runtime: string | null;
  genres: string[];
  cast: string[];
  director: string[];
  writers?: string[];
  country?: string | null;
  awards?: string | null;
  status?: string | null;
  released?: string | null;
  imdbId?: string | null;
  /** YouTube id of the trailer. */
  trailer?: string | null;
  /** Similar titles, when the meta addon lists them in its links. */
  similar?: { type: MetaType; id: string; name: string }[];
  videos: Video[];
}

export interface CatalogDef {
  type: MetaType;
  id: string;
  name: string;
  genres: string[];
  genreRequired: boolean;
  skip: boolean;
  home: boolean;
}

export interface Progress {
  videoId: string;
  metaId: string;
  type: MetaType;
  name: string;
  poster: string | null;
  episode: string | null;
  position: number;
  duration: number | null;
  watched: boolean;
  updatedAt: number;
}

export interface LibraryItem extends SearchResult {
  addedAt: number;
  /** Last time I watched something of this title (null: never). */
  lastWatchedAt?: number | null;
}

export interface UserAddon {
  id: string;
  name: string;
  url: string;
  addedAt: number;
}

export interface StreamOption {
  key: string;
  addon: string;
  label: string;
  release: string;
  quality: string | null;
  seeders: number | null;
  size: string | null;
  origin: string | null;
  hdr: boolean;
  dolbyVision: boolean;
  hevc: boolean;
  cached: boolean;
  /** MULTI (VF + VO), VF, VOSTFR, from the release name. */
  languages?: string[];
  /** Torrent bigger than the server's storage allows: shown, but can't be started. */
  tooBig?: boolean;
  kind: 'torrent' | 'http';
}

let sessionToken = '';

export function setSession(token: string) {
  sessionToken = token;
}

export function getSession() {
  return sessionToken;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
  return body as T;
}

/** Third-party images must go through the backend inside the Discord iframe. */
export function img(url: string | null | undefined) {
  if (!url) return '';
  return `/api/img?u=${encodeURIComponent(url.replace(/^http:/, 'https:'))}`;
}
