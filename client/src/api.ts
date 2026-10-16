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
}

export interface Member {
  uid: string;
  name: string;
  avatar: string | null;
  quality: string | null;
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
