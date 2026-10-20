// Which codecs this device really decodes. MediaSource.isTypeSupported only says the type
// is known: Discord on Windows can answer yes for HEVC 10-bit and then show a black picture
// while the time runs. So each codec plays a tiny sample (codecsamples.ts, one known colour)
// and counts only if the colour comes out. A codec that passes is copied as is by the server;
// one that fails is converted to H.264, which every device plays.
import { AV1_SAMPLE, HEVC_SAMPLE, VP9_SAMPLE } from './codecsamples.ts';
import { localStorageGet, localStorageSet } from './storage.ts';

export interface Caps {
  hevc: boolean;
  av1: boolean;
  vp9: boolean;
}
export type Codec = keyof Caps;

export const NO_CAPS: Caps = { hevc: false, av1: false, vp9: false };

/**
 * What the server sends this viewer at this quality (mirror of converterParams in
 * server/src/media.js): the source as is ("copy") or converted to H.264.
 */
export function outputOf(source: { codec: string; width: number }, maxWidth: number, caps: Caps) {
  const codec = source.codec;
  const decodable = codec === 'h264' || (codec in caps && caps[codec as Codec]);
  const copy = decodable && source.width <= maxWidth * 1.05;
  return copy ? { mode: 'copy' as const, codec } : { mode: 'transcode' as const, codec: 'h264' };
}


const KEY = 'wp-codecs-v1';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const EXPECTED: [number, number, number] = [200, 60, 120];

/** Type strings: the sample's own, and the one a real film needs (4K, 10-bit). */
const SAMPLES: Record<Codec, { data: string; sample: string; film: string[] }> = {
  hevc: {
    data: HEVC_SAMPLE,
    sample: 'video/mp4; codecs="hvc1.2.4.L60.B0"',
    film: ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/mp4; codecs="hev1.2.4.L153.B0"'],
  },
  av1: { data: AV1_SAMPLE, sample: 'video/mp4; codecs="av01.0.00M.10"', film: ['video/mp4; codecs="av01.0.12M.10"'] },
  vp9: { data: VP9_SAMPLE, sample: 'video/mp4; codecs="vp09.02.10.10"', film: ['video/mp4; codecs="vp09.02.51.10"'] },
};

interface Stored {
  ua: string;
  at: number;
  caps: Caps;
  /** Codecs that failed during a real film (black picture): off until the browser changes. */
  broken: Codec[];
}

function mediaSourceClass(): typeof MediaSource | undefined {
  return window.MediaSource || (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
}

function read(): Stored | null {
  try {
    const s = JSON.parse(localStorageGet(KEY) || 'null') as Stored | null;
    return s && s.ua === navigator.userAgent ? s : null;
  } catch {
    return null;
  }
}

function write(s: Stored) {
  localStorageSet(KEY, JSON.stringify(s));
}

/** Codecs known to work here, from the last test (instant; nothing before the first test). */
export function cachedCaps(): Caps {
  const s = read();
  if (!s) return { ...NO_CAPS };
  const caps = { ...s.caps };
  for (const c of s.broken) caps[c] = false;
  return caps;
}

/** A film in this codec showed no picture: never copy it here again (until the browser changes). */
export function markBroken(codec: Codec) {
  const s = read() || { ua: navigator.userAgent, at: Date.now(), caps: { ...NO_CAPS }, broken: [] };
  if (!s.broken.includes(codec)) s.broken.push(codec);
  write(s);
}

/** Runs the tests (or reuses a recent result). */
export async function probeCaps(): Promise<Caps> {
  const s = read();
  if (s && Date.now() - s.at < MAX_AGE_MS) return cachedCaps();
  const caps = { ...NO_CAPS };
  for (const codec of Object.keys(SAMPLES) as Codec[]) {
    caps[codec] = await probeCodec(codec).catch(() => false);
  }
  write({ ua: navigator.userAgent, at: Date.now(), caps, broken: s?.broken || [] });
  return cachedCaps();
}

/** Plays one sample in a hidden video and checks its colour. */
export async function probeCodec(codec: Codec, timeoutMs = 4000): Promise<boolean> {
  const MS = mediaSourceClass();
  const spec = SAMPLES[codec];
  if (!MS || !MS.isTypeSupported(spec.sample) || !spec.film.some((t) => MS.isTypeSupported(t))) return false;
  const bytes = Uint8Array.from(atob(spec.data), (c) => c.charCodeAt(0));

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // ManagedMediaSource (iOS) only plays with remote playback off.
  (video as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
  video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:0;top:0';
  document.body.append(video);
  const ms = new MS();
  const url = URL.createObjectURL(ms);
  let timer = 0;
  let poll = 0;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = window.setTimeout(() => resolve(false), timeoutMs);
      // Events come in different orders across browsers: look a few times a frame, until
      // the right colour shows up (or the time runs out).
      const look = () => {
        if (video.videoWidth === 256 && video.readyState >= 2 && colourMatches(video)) resolve(true);
      };
      poll = window.setInterval(look, 50);
      video.addEventListener('error', () => resolve(false));
      ms.addEventListener(
        'sourceopen',
        () => {
          try {
            const sb = ms.addSourceBuffer(spec.sample);
            sb.addEventListener('updateend', () => {
              if (ms.readyState === 'open') ms.endOfStream();
              video.play().catch(() => {});
            });
            sb.addEventListener('error', () => resolve(false));
            sb.appendBuffer(bytes);
          } catch {
            resolve(false);
          }
        },
        { once: true }
      );
      video.src = url;
    });
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

function colourMatches(video: HTMLVideoElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true; // Can't look: the type and the decode both worked, trust it.
  try {
    ctx.drawImage(video, 0, 0, 8, 8);
    const [r, g, b] = ctx.getImageData(4, 4, 1, 1).data;
    return isExpectedColour([r, g, b]);
  } catch {
    return true;
  }
}

/** The sample's colour after YUV → RGB, within what colour conversions change. */
export function isExpectedColour([r, g, b]: [number, number, number] | Uint8ClampedArray | number[]) {
  return Math.abs(r - EXPECTED[0]) < 45 && Math.abs(g - EXPECTED[1]) < 45 && Math.abs(b - EXPECTED[2]) < 45;
}
