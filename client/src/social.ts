// Pure helpers of the social layer (votes, host, presence). Tested in social.test.ts.
// The server (server/src/rooms.js) is authoritative: these only decide what to show.

import type { Member, RoomState } from './api.ts';

/** Votes needed for a strict majority of n present members. */
export function majorityNeeded(n: number) {
  return Math.floor(n / 2) + 1;
}

/** Votes from people still in the room. */
export function presentVotes(voters: string[], members: Pick<Member, 'uid'>[]) {
  const here = new Set(members.map((m) => m.uid));
  return voters.filter((v) => here.has(v)).length;
}

/** Nothing to watch right now (anyone may start something). */
export function isIdle(s: RoomState | null) {
  return !s?.media || !!(s.done ?? s.ended);
}

/** Host or co-pilote: answers requests and the waiting room. */
export function isModerator(s: RoomState | null, uid: string) {
  return !!s && (s.host === uid || !!s.copilots?.includes(uid));
}

/** Plays/pauses/seeks/starts directly (otherwise: requests and votes). */
export function canControl(s: RoomState | null, uid: string) {
  if (!s) return false;
  return s.control === 'all' || isModerator(s, uid);
}

export const canStart = canControl;

/** Same rule as the server: strict majority and at least 2 votes. */
export function votesNeeded(n: number) {
  return Math.max(2, majorityNeeded(n));
}

export function roleLabel(s: RoomState, uid: string) {
  if (s.host === uid) return 'hôte';
  if (s.copilots?.includes(uid)) return 'co-pilote';
  return null;
}

export function memberStateLabel(m: Pick<Member, 'state' | 'external'>) {
  if (m.external) return 'lecteur externe';
  if (m.state === 'loading') return 'en chargement';
  if (m.state === 'browsing') return 'parcourt le catalogue';
  return 'en train de regarder';
}

/** "42:10", "1:02:05", "90" (seconds) → seconds; null when unreadable. */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Whole seconds left before a server-time deadline (never negative). */
export function secondsLeft(at: number, serverNow: number) {
  return Math.max(0, Math.ceil((at - serverNow) / 1000));
}
