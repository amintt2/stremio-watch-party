// Outgoing requests to addresses that come from outside (a personal addon, a stream link,
// a URL given to the Stremio gateway) must not reach the private network: the other
// containers (huwa, stremio), the host, cloud metadata. Checked on the resolved addresses,
// and again at every redirect (followed by hand).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** An address on the internet (not loopback, private, link-local, CGNAT, multicast). */
export function isPublicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (v === 6) {
    const h = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPublicAddress(mapped[1]);
    return !(h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || h.startsWith('64:ff9b:') || h.startsWith('ff'));
  }
  return false;
}

/** A host name that can be public (a literal private IP or a local-only name cannot). */
export function isPublicHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host)) return isPublicAddress(host);
  return host.includes('.');
}

/** "[::1]" → "::1", "Example.COM." → "example.com". */
export function normalizeHost(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
}

/**
 * Throws (status 403) unless the URL is http(s) and every address its host resolves to is
 * public. `trustedHosts`: hosts the operator configured (their addons), allowed as they are.
 */
export async function assertPublicUrl(url, { trustedHosts = null, resolve = lookup } = {}) {
  const u = url instanceof URL ? url : new URL(url);
  const refuse = () => {
    throw Object.assign(new Error('Adresse refusée (réseau privé)'), { status: 403, code: 'PRIVATE_ADDRESS' });
  };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') refuse();
  const host = normalizeHost(u.hostname);
  if (trustedHosts?.has(host)) return u;
  if (!isPublicHost(host)) refuse();
  if (isIP(host)) return u;
  const addresses = await resolve(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) refuse();
  return u;
}

/**
 * fetch() that only goes to public addresses and follows redirects itself, checking each
 * hop. Same options as fetch, plus { maxRedirects, trustedHosts, allowPrivate }.
 */
export async function safeFetch(url, init = {}, { maxRedirects = 5, trustedHosts = null, allowPrivate = false, fetchImpl = fetch, resolve } = {}) {
  let current = String(url);
  for (let hop = 0; ; hop++) {
    if (!allowPrivate) await assertPublicUrl(current, { trustedHosts, resolve });
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      // maxRedirects 0: the caller follows them itself (and sees each one).
      if (maxRedirects === 0) return res;
      res.body?.cancel?.().catch(() => {});
      if (hop >= maxRedirects) throw new Error('Trop de redirections');
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}
