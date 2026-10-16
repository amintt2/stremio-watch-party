import { DiscordSDK } from '@discord/embedded-app-sdk';
import { api, setSession, type User } from './api.ts';

export interface Identity {
  user: User;
  mode: 'discord' | 'browser';
}

/** Discord passes frame_id (among others) to the Activity URL. */
export function insideDiscord() {
  return new URLSearchParams(location.search).has('frame_id');
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
  const cfg = await api<{ clientId: string | null; browserMode: boolean; publicUrl: string }>('/api/config');
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
    return { user: res.user, mode: 'discord' };
  }

  if (!cfg.browserMode) {
    throw new Error('Ouvre cette app depuis une Activité Discord (le mode navigateur est désactivé).');
  }
  // Browser test mode: ?room=xyz&name=Bob
  const params = new URLSearchParams(location.search);
  let name = params.get('name') || localStorageGet('wp-name');
  if (!name) {
    name = prompt('Ton pseudo ?') || 'Invité';
    localStorageSet('wp-name', name);
  }
  const res = await api<{ session: string; user: User }>('/api/dev-session', {
    method: 'POST',
    body: JSON.stringify({ name, room: params.get('room') || 'test' }),
  });
  setSession(res.session);
  return { user: res.user, mode: 'browser' };
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
