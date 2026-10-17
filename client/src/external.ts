// "Ouvrir dans…": links that hand the room's file to a native player (pure, tested).
//
// The file URL comes from POST /api/media/:sid/external: a private, signed, direct link
// to the original file (every audio track, embedded subtitles, no transcoding).

export type Platform = 'android' | 'ios' | 'desktop';

export interface ExternalFile {
  url: string;
  /** File name (players show it). */
  name: string;
  /** "Dune · S1E02": what the player shows as the title when it takes one. */
  title: string;
  /** Room position in seconds, to start there when the player takes a start time. */
  position: number;
}

export type OptionId = 'site' | 'vlc' | 'mx' | 'mx-pro' | 'chooser' | 'infuse' | 'outplayer' | 'nplayer' | 'm3u' | 'copy';

export interface ExternalOption {
  id: OptionId;
  label: string;
  hint?: string;
  /** The player starts at the given position (else: "Recaler" tells where to go). */
  startsAt: boolean;
  /** A native app link (custom scheme / intent): impossible from inside Discord. */
  native: boolean;
}

/** From the user agent; iPadOS says "Macintosh" but has a touch screen. */
export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=';

/**
 * Android intent link (Chrome & WebViews): "intent://host/path#Intent;scheme=https;...;end".
 * VLC reads "title" (String) and "position" (long, ms); MX Player "title" and "position"
 * (int, ms). Without a package Android shows its "Ouvrir avec" chooser.
 */
export function androidIntent(file: ExternalFile, pkg: string | null, positionType: 'l' | 'i' = 'l') {
  const u = new URL(file.url);
  const parts = [`scheme=${u.protocol.replace(':', '')}`, 'action=android.intent.action.VIEW', 'type=video/*'];
  if (pkg) parts.push(`package=${pkg}`);
  parts.push(`S.title=${encodeURIComponent(file.title || file.name)}`);
  const ms = Math.max(0, Math.floor(file.position * 1000));
  if (ms > 0) parts.push(`${positionType}.position=${ms}`);
  // Not installed: Chrome opens the store page instead of failing silently.
  if (pkg) parts.push(`S.browser_fallback_url=${encodeURIComponent(PLAY_STORE + pkg)}`);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;${parts.join(';')};end`;
}

/** VLC for iOS (x-callback-url, documented by VideoLAN). No start time. */
export function vlcIosUrl(url: string) {
  return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
}

/** Infuse (documented by Firecore). No start time. */
export function infuseUrl(url: string) {
  return `infuse://x-callback-url/play?url=${encodeURIComponent(url)}`;
}

/** Outplayer: its scheme followed by the link. */
export function outplayerUrl(url: string) {
  return `outplayer://${url}`;
}

/** nPlayer: "nplayer-" in front of the link. */
export function nplayerUrl(url: string) {
  return `nplayer-${url}`;
}

/** Playlist for desktop players (VLC, mpv, MPC-HC...): VLC starts at the room's position. */
export function m3uPlaylist(file: ExternalFile) {
  const title = (file.title || file.name).replace(/[\r\n]+/g, ' ');
  const start = Math.max(0, Math.floor(file.position));
  return ['#EXTM3U', `#EXTINF:-1,${title}`, ...(start > 0 ? [`#EXTVLCOPT:start-time=${start}`] : []), file.url, ''].join('\n');
}

/** "Dune (2021).m3u": a file name every system accepts. */
export function playlistName(title: string) {
  const base = title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'video'}.m3u`;
}

/** What to offer, in order. Inside Discord the site comes first (native links can't open there). */
export function externalOptions(platform: Platform, inDiscord: boolean): ExternalOption[] {
  const list: ExternalOption[] = [];
  if (inDiscord) list.push({ id: 'site', label: 'Ouvrir sur le site', hint: 'Même salle, sans te reconnecter', startsAt: false, native: false });
  if (platform === 'android') {
    list.push(
      { id: 'vlc', label: 'VLC', startsAt: true, native: true },
      { id: 'mx', label: 'MX Player', startsAt: true, native: true },
      { id: 'mx-pro', label: 'MX Player Pro', startsAt: true, native: true },
      { id: 'chooser', label: 'Autre lecteur…', hint: 'Choisir une app installée', startsAt: false, native: true }
    );
  } else if (platform === 'ios') {
    list.push(
      { id: 'vlc', label: 'VLC', startsAt: false, native: true },
      { id: 'infuse', label: 'Infuse', startsAt: false, native: true },
      { id: 'outplayer', label: 'Outplayer', startsAt: false, native: true },
      { id: 'nplayer', label: 'nPlayer', startsAt: false, native: true }
    );
  } else {
    list.push({ id: 'm3u', label: 'Ouvrir dans VLC', hint: 'Télécharge une playlist .m3u à ouvrir avec VLC', startsAt: true, native: true });
  }
  list.push({ id: 'copy', label: 'Copier le lien', hint: 'À coller dans n’importe quel lecteur', startsAt: false, native: false });
  return list;
}

/** Link for a native option on a platform (null: not a link, the UI handles it). */
export function nativeHref(id: OptionId, platform: Platform, file: ExternalFile): string | null {
  if (platform === 'android') {
    if (id === 'vlc') return androidIntent(file, 'org.videolan.vlc', 'l');
    if (id === 'mx') return androidIntent(file, 'com.mxtech.videoplayer.ad', 'i');
    if (id === 'mx-pro') return androidIntent(file, 'com.mxtech.videoplayer.pro', 'i');
    if (id === 'chooser') return androidIntent(file, null);
  }
  if (platform === 'ios') {
    if (id === 'vlc') return vlcIosUrl(file.url);
    if (id === 'infuse') return infuseUrl(file.url);
    if (id === 'outplayer') return outplayerUrl(file.url);
    if (id === 'nplayer') return nplayerUrl(file.url);
  }
  return null;
}
