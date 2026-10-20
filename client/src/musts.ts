// "Obligations" under "Lire": what the automatic choice must respect (VF + VO, French
// subtitles, 1080p at least…). Kept per viewer; "Lire" only races the sources that meet
// all of them. Pure parts are tested in musts.test.ts.
import type { StreamOption } from './api.ts';
import { localStorageGet, localStorageSet } from './storage.ts';

export type Must = 'multi' | 'vf' | 'stfr' | 'hd' | 'uhd' | 'debrid';

export const MUSTS: { id: Must; label: string; hint: string }[] = [
  { id: 'multi', label: 'VF + VO', hint: 'Les deux langues dans le fichier (MULTI) : chacun choisit la sienne' },
  { id: 'vf', label: 'VF', hint: 'Audio français (VF ou MULTI)' },
  { id: 'stfr', label: 'ST FR', hint: 'Sous-titres français dans le fichier (VOSTFR ou MULTI)' },
  { id: 'hd', label: '1080p+', hint: '1080p ou 4K' },
  { id: 'uhd', label: '4K', hint: '4K seulement' },
  { id: 'debrid', label: '⚡ Débrid', hint: 'Lien débrid prêt (démarre le plus vite)' },
];

const KEY = 'wp-musts';

/** Does this source meet every obligation? */
export function meets(s: Pick<StreamOption, 'languages' | 'quality' | 'cached'>, musts: Must[]) {
  const langs = s.languages || [];
  return musts.every((m) => {
    switch (m) {
      case 'multi':
        return langs.includes('MULTI');
      case 'vf':
        return langs.includes('MULTI') || langs.includes('VF');
      case 'stfr':
        return langs.includes('MULTI') || langs.includes('VOSTFR');
      case 'hd':
        return s.quality === '1080p' || s.quality === '4K';
      case 'uhd':
        return s.quality === '4K';
      case 'debrid':
        return s.cached;
      default:
        return true;
    }
  });
}

/** "VF + VO, 1080p+" for messages. */
export function mustsLabel(musts: Must[]) {
  return MUSTS.filter((m) => musts.includes(m.id)).map((m) => m.label).join(', ');
}

let current: Must[] = read();
const listeners = new Set<() => void>();

function read(): Must[] {
  try {
    const v = JSON.parse(localStorageGet(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is Must => MUSTS.some((m) => m.id === x)) : [];
  } catch {
    return [];
  }
}

export function getMusts(): Must[] {
  return [...current];
}

export function toggleMust(id: Must) {
  current = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  localStorageSet(KEY, JSON.stringify(current));
  for (const fn of listeners) fn();
}

/** Called when the obligations change (both rows on a page stay in step). */
export function onMustsChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
