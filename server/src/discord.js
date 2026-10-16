import { config } from './config.js';

const API = 'https://discord.com/api';

/** Exchanges the code from discordSdk.commands.authorize() for an access token. */
export async function exchangeCode(code) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Discord token exchange failed (${res.status}): ${body.error || 'unknown'}`);
  }
  return body.access_token;
}

export async function fetchUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed (${res.status})`);
  const user = await res.json();
  return {
    uid: user.id,
    name: user.global_name || user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : null,
  };
}
