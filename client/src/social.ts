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
  return !s?.media || !!s.ended;
}

export function canControl(s: RoomState | null, uid: string) {
  return !s || s.control !== 'host' || s.host === uid;
}

export function canStart(s: RoomState | null, uid: string) {
  return isIdle(s) || canControl(s, uid);
}

export function memberStateLabel(m: Pick<Member, 'state'>) {
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
