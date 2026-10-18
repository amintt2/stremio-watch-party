import type { MetaType, RoomInfo, RoomState, User } from './api.ts';
import type { Player } from './player.ts';

export type Mode = 'discord' | 'web' | 'guest';

export interface PlayRequest {
  /** A source chosen by hand… */
  streamKey?: string;
  /** …or every source found: the server races them and keeps the fastest (race.js). */
  candidates?: string[];
  meta: { id: string; type: MetaType; name: string; poster: string | null };
  videoId: string;
  /** "S1E02 · Pilot" for an episode, empty for a movie. */
  subtitle: string;
  startAt?: number;
}

/** What the shell gives each view. */
export interface App {
  me: User;
  mode: Mode;
  room: RoomInfo | null;
  player: Player;
  state(): RoomState | null;
  navigate(href: string, replace?: boolean): void;
  /** New URL params for the page shown, without rebuilding it (text filters). */
  replaceRoute(href: string): void;
  /** Starts a source for the whole room (proposes it instead when only the host may). */
  play(req: PlayRequest): Promise<void>;
  /** Adds a title/episode to the room queue, with an optional chosen source. */
  propose(req: Omit<PlayRequest, 'streamKey' | 'startAt' | 'candidates'> & { streamKey?: string }): Promise<void>;
}

export interface View {
  el: HTMLElement;
  dispose?: () => void;
}
