import { DiscordSDK } from '@discord/embedded-app-sdk';
import { api, setSession, type RoomInfo, type User } from './api.ts';
import type { Mode } from './app.ts';
import { h } from './dom.ts';
import { legalFooter } from './ui.ts';

export interface Identity {
  user: User;
  mode: Mode;
  room: RoomInfo | null;
}

interface ServerConfig {
  clientId: string | null;
  browserMode: boolean;
  webLogin: boolean;
  publicUrl: string;
}

/** Discord passes frame_id (among others) to the Activity URL. */
export function insideDiscord() {
  return new URLSearchParams(location.search).has('frame_id');
}

/** Thrown outside Discord when nobody is logged in: the app shows the login screen. */
export class LoginRequired extends Error {
  constructor(readonly config: ServerConfig) {
    super('Connexion requise');
  }
}

let discordSdk: DiscordSDK | null = null;
let publicUrl = location.origin;

/**
 * Opens a page outside the app. Inside the Discord iframe plain links are blocked,
 * so they go through the SDK (Discord asks the user to confirm).
 */
export function openExternal(url: string) {
  const absolute = new URL(url, publicUrl).toString();
  if (discordSdk) discordSdk.commands.openExternalLink({ url: absolute }).catch(() => {});
  else window.open(absolute, '_blank', 'noopener');
}

export async function signIn(): Promise<Identity> {
  const cfg = await api<ServerConfig>('/api/config');
  if (cfg.publicUrl) publicUrl = cfg.publicUrl;

  if (insideDiscord()) {
    if (!cfg.clientId) throw new Error('DISCORD_CLIENT_ID manquant côté serveur');
    const sdk = new DiscordSDK(cfg.clientId);
    discordSdk = sdk;
    await sdk.ready();
    const { code } = await sdk.commands.authorize({
      client_id: cfg.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    const res = await api<{ access_token: string; session: string; user: User }>('/api/token', {
      method: 'POST',
      body: JSON.stringify({ code, instanceId: sdk.instanceId }),
    });
    await sdk.commands.authenticate({ access_token: res.access_token });
    setSession(res.session);
    return { user: res.user, mode: 'discord', room: null };
  }

  const params = new URLSearchParams(location.search);
  const room = params.get('room') || undefined;

  // Website: the httpOnly cookie from the Discord login identifies the account.
  try {
    const res = await api<{ session: string; user: User; room: RoomInfo }>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ room }),
    });
    setSession(res.session);
    return { user: res.user, mode: 'web', room: res.room };
  } catch (err) {
    if (!/connecté|401/i.test((err as Error).message)) throw err;
  }

  // Local test mode: ?room=xyz&name=Bob, or the guest form.
  const name = params.get('name') || (cfg.browserMode ? localStorageGet('wp-name') : null);
  if (cfg.browserMode && name) return guestSignIn(name, room);
  throw new LoginRequired(cfg);
}

export async function guestSignIn(name: string, room?: string): Promise<Identity> {
  localStorageSet('wp-name', name);
  const res = await api<{ session: string; user: User; room: RoomInfo }>('/api/dev-session', {
    method: 'POST',
    body: JSON.stringify({ name, room: room || 'test' }),
  });
  setSession(res.session);
  return { user: res.user, mode: 'guest', room: res.room };
}

/** Login screen outside Discord: Discord OAuth, plus a guest form in local test mode. */
export function loginScreen(cfg: ServerConfig, onGuest: (id: Identity) => void) {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const failed = params.get('login') === 'failed';
  const loginHref = `/api/auth/discord/login${room ? `?room=${encodeURIComponent(room)}` : ''}`;

  const nameInput = h('input', { class: 'input input-lg', placeholder: 'Ton pseudo', 'aria-label': 'Pseudo', maxlength: 32, required: true });
  const guest = cfg.browserMode
    ? h(
        'form',
        {
          class: 'login-guest',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            if (!nameInput.value.trim()) return;
            onGuest(await guestSignIn(nameInput.value.trim(), room || undefined));
          },
        },
        h('p', { class: 'faint small' }, 'Mode test local (invité, sans Discord)'),
        h('div', { class: 'inline-form' }, nameInput, h('button', { class: 'btn btn-secondary', type: 'submit' }, 'Entrer'))
      )
    : null;

  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      h('div', { class: 'brand brand-lg' }, h('span', { class: 'brand-mark' }, 'W'), h('span', {}, 'Watch Party')),
      h('p', { class: 'muted' }, room ? 'Un ami t’invite à regarder ensemble. Connecte-toi pour rejoindre sa salle.' : 'Regarde des films et des séries avec tes amis, synchronisés.'),
      failed ? h('p', { class: 'auth-error' }, 'La connexion a échoué, réessaie.') : null,
      cfg.webLogin
        ? h('a', { class: 'btn btn-primary btn-lg btn-block', href: loginHref }, 'Se connecter avec Discord')
        : h('p', { class: 'muted small' }, 'Connexion Discord non configurée sur le serveur.'),
      guest
    ),
    legalFooter()
  );
}

export function localStorageGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode, iframe policy) */
  }
}
