// Homescreen / PWA icon variants.
//
// Multiple grok-remote installs on the same phone (different tailnet hosts)
// all used the same teal "GR" icon. Users can pick a color variant per
// origin so each install is visually distinct on the home screen.
//
// Persistence: localStorage key `grok-remote.ui.appIcon` (per origin).
// When unset, a stable hash of the current host picks a default so two
// hosts rarely collide even before the user customizes.
//
// Applying an icon updates:
//   - <link rel="icon">
//   - <link rel="apple-touch-icon">
//   - <link rel="manifest"> (blob URL with matching PNG icons + names)
//
// Note: iOS freezes the apple-touch-icon at "Add to Home Screen" time.
// Re-add the app (or remove + add) after changing the icon.

export const APP_ICON_KEY = 'grok-remote.ui.appIcon';
export const APP_ICON_CHANGE = 'grok-remote:app-icon-change';

export interface AppIconVariant {
  id: string;
  label: string;
  /** Top of the monogram gradient */
  fg0: string;
  /** Bottom of the monogram gradient */
  fg1: string;
  /** Top of the background gradient */
  bg0: string;
  /** Bottom of the background gradient */
  bg1: string;
  /** Subtle border / stroke */
  border: string;
}

export const APP_ICONS: AppIconVariant[] = [
  {
    id: 'teal',
    label: 'teal',
    fg0: '#5eead4', fg1: '#79c0ff',
    bg0: '#0c1117', bg1: '#07090c',
    border: '#1c2530',
  },
  {
    id: 'amber',
    label: 'amber',
    fg0: '#fbbf24', fg1: '#f97316',
    bg0: '#1a1208', bg1: '#0f0b06',
    border: '#3a2a14',
  },
  {
    id: 'rose',
    label: 'rose',
    fg0: '#fb7185', fg1: '#e879f9',
    bg0: '#1a0c14', bg1: '#0f070c',
    border: '#3a1c2e',
  },
  {
    id: 'violet',
    label: 'violet',
    fg0: '#a78bfa', fg1: '#818cf8',
    bg0: '#100c1c', bg1: '#080612',
    border: '#2a2240',
  },
  {
    id: 'lime',
    label: 'lime',
    fg0: '#a3e635', fg1: '#34d399',
    bg0: '#0c140c', bg1: '#070d07',
    border: '#1e301e',
  },
  {
    id: 'sky',
    label: 'sky',
    fg0: '#38bdf8', fg1: '#60a5fa',
    bg0: '#0a1220', bg1: '#060a12',
    border: '#1a2838',
  },
  {
    id: 'coral',
    label: 'coral',
    fg0: '#fb923c', fg1: '#f43f5e',
    bg0: '#1a0c0a', bg1: '#100706',
    border: '#3a2018',
  },
  {
    id: 'mono',
    label: 'mono',
    fg0: '#e8f0f8', fg1: '#8693a4',
    bg0: '#11141a', bg1: '#0a0c10',
    border: '#2a3038',
  },
];

const DEFAULT_ID = 'teal';

function hashHost(host: string): number {
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getAppIconMeta(id?: string | null): AppIconVariant {
  const found = APP_ICONS.find((v) => v.id === id);
  return found || APP_ICONS[0]!;
}

/** Explicit stored preference, or null when unset (auto-from-host). */
export function getStoredAppIconId(): string | null {
  try {
    const v = localStorage.getItem(APP_ICON_KEY);
    if (v && APP_ICONS.some((i) => i.id === v)) return v;
  } catch { /* ignore */ }
  return null;
}

/** Effective icon id: stored choice, else host-hash default, else teal. */
export function getAppIconId(host?: string): string {
  const stored = getStoredAppIconId();
  if (stored) return stored;
  const h = host
    || (typeof location !== 'undefined' ? location.hostname : '')
    || '';
  if (!h) return DEFAULT_ID;
  return APP_ICONS[hashHost(h) % APP_ICONS.length]!.id;
}

export function setAppIconId(id: string): string {
  const meta = getAppIconMeta(id);
  try { localStorage.setItem(APP_ICON_KEY, meta.id); } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent(APP_ICON_CHANGE, {
      detail: { id: meta.id },
    }));
  } catch { /* ignore */ }
  return meta.id;
}

/** Build an SVG monogram icon at the given pixel size. */
export function buildIconSvg(size: number, variant?: AppIconVariant, opts?: { maskable?: boolean }): string {
  const v = variant || getAppIconMeta(getAppIconId());
  const maskable = !!(opts && opts.maskable);
  const rx = maskable ? 0 : Math.round(size * 0.1875);
  const pad = maskable ? 0 : Math.max(2, Math.round(size * 0.03));
  const strokeW = Math.max(1, Math.round(size * 0.01));
  const fontSize = maskable
    ? Math.round(size * 0.34)
    : Math.round(size * 0.46);
  // Optical vertical center for the monogram in a monospace face.
  const textY = Math.round(size * (maskable ? 0.60 : 0.65));
  const letterSpacing = Math.max(1, Math.round(size * 0.01));
  const innerRx = Math.max(0, rx - pad);
  const border = maskable
    ? ''
    : `<rect x="${pad}" y="${pad}" width="${size - pad * 2}" height="${size - pad * 2}" rx="${innerRx}" ry="${innerRx}" fill="none" stroke="${v.border}" stroke-width="${strokeW}"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${v.bg0}"/>
      <stop offset="100%" stop-color="${v.bg1}"/>
    </linearGradient>
    <linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${v.fg0}"/>
      <stop offset="100%" stop-color="${v.fg1}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="url(#bg)"/>
  ${border}
  <text x="${size / 2}" y="${textY}"
    text-anchor="middle"
    font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    font-weight="700"
    font-size="${fontSize}"
    letter-spacing="${letterSpacing}"
    fill="url(#fg)">GR</text>
</svg>`;
}

export function iconSvgDataUrl(size: number, variant?: AppIconVariant, opts?: { maskable?: boolean }): string {
  const svg = buildIconSvg(size, variant, opts);
  // Prefer base64 — some WebKit builds are picky about utf8 data URLs in link rel.
  if (typeof btoa === 'function') {
    const b64 = btoa(unescape(encodeURIComponent(svg)));
    return `data:image/svg+xml;base64,${b64}`;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function svgToPngDataUrl(svg: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      reject(new Error('no DOM'));
      return;
    }
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no canvas')); return; }
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('svg rasterize failed'));
    };
    img.src = url;
  });
}

function ensureLink(rel: string, attrs?: Record<string, string>): HTMLLinkElement {
  let link = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
  // apple-touch-icon may already exist; favicon might be a data: icon.
  if (!link && rel === 'icon') {
    link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  }
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.appendChild(link);
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) link.setAttribute(k, v);
  }
  return link;
}

let _manifestObjectUrl: string | null = null;
let _applySeq = 0;

export interface ApplyAppIconOpts {
  /** Override host used for auto-default and manifest naming. */
  host?: string;
  /** Full untruncated host for the long name. */
  fullHost?: string;
}

/**
 * Apply the current (or given) app icon to the document head and rebuild
 * the web app manifest as a blob URL so "Add to Home Screen" picks it up.
 */
export async function applyAppIcon(id?: string, opts?: ApplyAppIconOpts): Promise<string> {
  const host = opts?.host
    || (typeof location !== 'undefined' ? location.hostname : '')
    || '';
  const resolved = id || getAppIconId(host);
  const variant = getAppIconMeta(resolved);
  const seq = ++_applySeq;

  // Instant SVG favicon so the tab updates without waiting on canvas.
  const favSvg = iconSvgDataUrl(64, variant);
  ensureLink('icon', { type: 'image/svg+xml', href: favSvg });

  // Rasterize for apple-touch + manifest (iOS prefers PNG).
  try {
    const [png180, png192, png512, pngMask] = await Promise.all([
      svgToPngDataUrl(buildIconSvg(180, variant), 180),
      svgToPngDataUrl(buildIconSvg(192, variant), 192),
      svgToPngDataUrl(buildIconSvg(512, variant), 512),
      svgToPngDataUrl(buildIconSvg(512, variant, { maskable: true }), 512),
    ]);
    if (seq !== _applySeq) return resolved; // superseded

    ensureLink('apple-touch-icon', { href: png180 });
    // Also set a PNG favicon for browsers that ignore SVG.
    ensureLink('icon', { type: 'image/png', sizes: '192x192', href: png192 });

    const fullHost = opts?.fullHost || host || 'Grok Remote';
    const shortHost = fullHost.split('.')[0] || fullHost;
    const shortName = shortHost.length > 12 ? shortHost.slice(0, 11) + '…' : shortHost;
    const manifest = {
      name: host ? `Grok Remote · ${fullHost}` : 'Grok Remote',
      short_name: host ? shortName : 'GR',
      description: host
        ? `Manage grok agents on ${fullHost}.`
        : 'Manage grok agents over your tailnet.',
      start_url: '/',
      display: 'standalone',
      background_color: variant.bg1,
      theme_color: variant.bg0,
      icons: [
        { src: png192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: png512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: pngMask, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };

    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    const url = URL.createObjectURL(blob);
    const manLink = ensureLink('manifest');
    const prev = manLink.href;
    manLink.href = url;
    if (_manifestObjectUrl && _manifestObjectUrl !== prev) {
      try { URL.revokeObjectURL(_manifestObjectUrl); } catch { /* ignore */ }
    }
    _manifestObjectUrl = url;
  } catch {
    // Headless / no-canvas environments: SVG favicon is enough.
  }

  return resolved;
}
