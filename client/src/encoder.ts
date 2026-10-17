// GPU encoder app (encoder/ in the repo): the host's PC prepares the qualities instead of
// the server. Settings section, the suggestion shown to hosts, and its download.
import { api } from './api.ts';
import { openExternal } from './auth.ts';
import { clear, h, toast } from './dom.ts';
import { localStorageGet, localStorageSet } from './storage.ts';
import { confirmButton, icon } from './ui.ts';

export interface EncoderStatus {
  online: boolean;
  encoder?: string;
  device?: string | null;
  maxHeight?: number;
  os?: string;
  version?: string;
  label?: string;
}

interface EncoderInfo {
  status: EncoderStatus;
  keys: { id: string; label: string; createdAt: number; seenAt: number | null }[];
  platforms: { id: string; label: string; available: boolean }[];
}

/** "Suggest the app" dismissed until this time (ms). */
const DISMISS_KEY = 'wp-encoder-later';

/** This device's system, to offer the right download first. */
export function guessPlatform(ua = navigator.userAgent, platform = (navigator as { platform?: string }).platform || ''): string | null {
  if (/android|iphone|ipad|ipod|mobile/i.test(ua)) return null;
  if (/windows/i.test(ua)) return 'windows';
  // Browsers don't tell Apple Silicon from Intel: the settings list both.
  if (/mac/i.test(ua) || /mac/i.test(platform)) return 'macos-arm64';
  if (/linux/i.test(ua)) return 'linux';
  return null;
}

/** Asks the server for a one-time link to the app already paired with this account. */
async function download(platform: string) {
  try {
    const { url } = await api<{ url: string }>('/api/encoder/pair', { method: 'POST', body: JSON.stringify({ platform }) });
    // From the Discord Activity the file opens in the real browser.
    openExternal(url);
    toast('Téléchargement lancé : ouvre le fichier, il se connecte tout seul');
  } catch (err) {
    toast((err as Error).message);
  }
}

/** "NVIDIA GeForce RTX 3070 · NVIDIA NVENC · 4K" */
export function statusLine(s: EncoderStatus) {
  if (!s.online) return 'Pas connecté';
  return [s.device, s.encoder, s.maxHeight === 2160 ? 'jusqu’à 4K' : s.maxHeight ? `jusqu’à ${s.maxHeight}p` : null].filter(Boolean).join(' · ');
}

/** Settings page section. */
export function encoderSection() {
  const body = h('div', { class: 'encoder-settings' }, h('p', { class: 'muted small' }, 'Chargement…'));
  const render = (info: EncoderInfo) => {
    const mine = guessPlatform();
    const platforms = [...info.platforms].sort((a, b) => Number(b.id === mine) - Number(a.id === mine));
    clear(
      body,
      h(
        'p',
        { class: 'muted' },
        'Lance l’Encodeur Watch Party sur ton PC : ta carte graphique prépare les qualités (4K, 1080p, 720p…) pour toute la salle à la place du serveur. ',
        'Il se connecte tout seul au site (aucun port à ouvrir) ; laisse sa fenêtre réduite pendant la séance.'
      ),
      h(
        'div',
        { class: `encoder-status${info.status.online ? ' online' : ''}` },
        h('span', { class: 'encoder-dot' }),
        h('strong', {}, info.status.online ? 'Ton encodeur est connecté' : 'Ton encodeur n’est pas lancé'),
        h('span', { class: 'muted small' }, info.status.online ? statusLine(info.status) : 'Les qualités sont préparées par le serveur.')
      ),
      h(
        'div',
        { class: 'encoder-downloads' },
        platforms.map((p) =>
          h(
            'button',
            {
              class: `btn ${p.id === mine ? 'btn-primary' : 'btn-secondary'} btn-sm`,
              type: 'button',
              disabled: !p.available,
              title: p.available ? '' : 'Pas encore compilé sur ce serveur',
              onclick: () => download(p.id),
            },
            icon('download', 'icon icon-sm'),
            p.label
          )
        )
      ),
      h(
        'p',
        { class: 'field-hint' },
        'Windows : un simple .exe (au premier lancement il télécharge ffmpeg, ~100 Mo). macOS / Linux : un .zip, ffmpeg doit être installé (brew / apt). ',
        'Utilise NVIDIA NVENC, Intel Quick Sync, AMD AMF, Apple VideoToolbox ou VA-API, sinon le processeur.'
      ),
      info.keys.length
        ? h(
            'div',
            { class: 'addon-list' },
            h('p', { class: 'muted small' }, 'PC jumelés à ton compte :'),
            info.keys.map((k) =>
              h(
                'div',
                { class: 'addon' },
                h('div', {}, h('strong', {}, k.label), h('span', { class: 'faint small' }, k.seenAt ? ` · vu le ${new Date(k.seenAt).toLocaleString('fr-FR')}` : ' · jamais connecté')),
                confirmButton({ class: 'btn btn-ghost btn-sm', label: 'Retirer', confirmLabel: 'Confirmer ?', icon: 'trash', title: `Retirer ${k.label}` }, async () => {
                  await api(`/api/encoder/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
                  toast('PC retiré : sa clé ne marche plus');
                  load();
                })
              )
            )
          )
        : null
    );
  };
  const load = () =>
    api<EncoderInfo>('/api/encoder')
      .then(render)
      .catch((err: Error) => clear(body, h('p', { class: 'auth-error' }, err.message)));
  load();
  return body;
}

/**
 * On a computer, the host is offered the app once in a while (not when it already runs,
 * not on phones, "Plus tard" = a week).
 */
export async function suggestEncoder(host: () => boolean, mount: HTMLElement) {
  const platform = guessPlatform();
  if (!platform) return;
  const later = Number(localStorageGet(DISMISS_KEY) || 0);
  if (later > Date.now()) return;
  // Wait for the room state: only the host gets the suggestion.
  for (let i = 0; i < 20 && !host(); i++) await new Promise((r) => setTimeout(r, 500));
  if (!host()) return;
  let info: EncoderInfo;
  try {
    info = await api<EncoderInfo>('/api/encoder');
  } catch {
    return;
  }
  const p = info.platforms.find((x) => x.id === platform);
  if (info.status.online || !p?.available) return;
  const close = (days: number) => {
    localStorageSet(DISMISS_KEY, String(Date.now() + days * 24 * 3600 * 1000));
    card.remove();
  };
  const card = h(
    'div',
    { class: 'encoder-suggest', role: 'status' },
    h('div', { class: 'encoder-suggest-text' }, h('strong', {}, 'Accélère la salle avec ton GPU'), h('span', {}, 'Tu es l’hôte : avec l’Encodeur Watch Party, ta carte graphique prépare la 4K, le 1080p et le 720p pour tout le monde, plus fluide que le serveur.')),
    h(
      'div',
      { class: 'encoder-suggest-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => (download(platform), close(30)) }, icon('download', 'icon icon-sm'), `Télécharger pour ${p.label}`),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => close(7) }, 'Plus tard'),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => close(3650) }, 'Ne plus proposer')
    )
  );
  mount.append(card);
}
