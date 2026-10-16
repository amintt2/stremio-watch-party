import type { Connection } from './connection.ts';

/**
 * Every room playback action of the player UI (button, click on the picture,
 * double tap, keyboard, seek bar, mini-player) goes through here. Today it sends
 * the room messages directly; a permission / request flow (host-only control)
 * can plug in here without touching the UI.
 */
export interface Playback {
  requestPlay(): void;
  requestPause(): void;
  requestSeek(position: number): void;
}

export function roomPlayback(conn: Connection): Playback {
  return {
    requestPlay: () => conn.send({ t: 'play' }),
    requestPause: () => conn.send({ t: 'pause' }),
    requestSeek: (position: number) => conn.send({ t: 'seek', position: Math.max(0, position) }),
  };
}
