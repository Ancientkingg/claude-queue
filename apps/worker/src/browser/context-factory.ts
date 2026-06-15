import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { AccountSessionProfile } from '@claude-queue/shared-types';
import type { ProxyConfig } from './proxy-rotator.js';

// We keep a singleton browser instance to avoid re-launching Chromium for every job.
// Each job gets its own isolated BrowserContext.
let browserInstance: Browser | null = null;

// ─── Timezone-to-geolocation resolver ───────────────────────────────────

interface TzGeo {
  lat: number;
  lng: number;
  /** BCP 47 locale tag (e.g. "en-US", "de-DE", "ja-JP") */
  locale: string;
}

function jitterVp(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

/**
 * Map IANA timezone IDs to approximate city-center coordinates and locale.
 * Coordinates are sourced from major population centers within each zone.
 * When a timezone isn't listed we fall back to a UTC-derived longitude and
 * a neutral "en" locale.
 */
const TZ_GEO: Record<string, TzGeo> = {
  // North America
  'America/New_York':       { lat: 40.7128,  lng: -74.0060,  locale: 'en-US' },
  'America/Chicago':        { lat: 41.8781,  lng: -87.6298,  locale: 'en-US' },
  'America/Denver':         { lat: 39.7392,  lng: -104.9903, locale: 'en-US' },
  'America/Los_Angeles':    { lat: 34.0522,  lng: -118.2437, locale: 'en-US' },
  'America/Phoenix':        { lat: 33.4484,  lng: -112.0740, locale: 'en-US' },
  'America/Anchorage':      { lat: 61.2181,  lng: -149.9003, locale: 'en-US' },
  'America/Boise':          { lat: 43.6150,  lng: -116.2023, locale: 'en-US' },
  'America/Indiana/Indianapolis': { lat: 39.7684, lng: -86.1581, locale: 'en-US' },
  'America/Toronto':        { lat: 43.6532,  lng: -79.3832,  locale: 'en-CA' },
  'America/Vancouver':      { lat: 49.2827,  lng: -123.1207, locale: 'en-CA' },
  'America/Montreal':       { lat: 45.5017,  lng: -73.5673,  locale: 'fr-CA' },
  'America/Mexico_City':    { lat: 19.4326,  lng: -99.1332,  locale: 'es-MX' },
  'America/Costa_Rica':     { lat: 9.9281,   lng: -84.0907,  locale: 'es-CR' },

  // South America
  'America/Sao_Paulo':      { lat: -23.5505, lng: -46.6333, locale: 'pt-BR' },
  'America/Argentina/Buenos_Aires': { lat: -34.6037, lng: -58.3816, locale: 'es-AR' },
  'America/Lima':           { lat: -12.0464, lng: -77.0428,  locale: 'es-PE' },
  'America/Bogota':         { lat: 4.7110,   lng: -74.0721,  locale: 'es-CO' },
  'America/Santiago':       { lat: -33.4489, lng: -70.6693,  locale: 'es-CL' },

  // Europe
  'Europe/London':          { lat: 51.5072,  lng: -0.1276,   locale: 'en-GB' },
  'Europe/Paris':           { lat: 48.8566,  lng: 2.3522,    locale: 'fr-FR' },
  'Europe/Berlin':          { lat: 52.5200,  lng: 13.4050,   locale: 'de-DE' },
  'Europe/Madrid':          { lat: 40.4168,  lng: -3.7038,   locale: 'es-ES' },
  'Europe/Rome':            { lat: 41.9028,  lng: 12.4964,   locale: 'it-IT' },
  'Europe/Amsterdam':       { lat: 52.3676,  lng: 4.9041,    locale: 'nl-NL' },
  'Europe/Stockholm':       { lat: 59.3293,  lng: 18.0686,   locale: 'sv-SE' },
  'Europe/Zurich':          { lat: 47.3769,  lng: 8.5417,    locale: 'de-CH' },
  'Europe/Vienna':          { lat: 48.2082,  lng: 16.3738,   locale: 'de-AT' },
  'Europe/Warsaw':          { lat: 52.2297,  lng: 21.0122,   locale: 'pl-PL' },
  'Europe/Lisbon':          { lat: 38.7223,  lng: -9.1393,   locale: 'pt-PT' },
  'Europe/Athens':          { lat: 37.9838,  lng: 23.7275,   locale: 'el-GR' },
  'Europe/Helsinki':        { lat: 60.1699,  lng: 24.9384,   locale: 'fi-FI' },
  'Europe/Dublin':          { lat: 53.3498,  lng: -6.2603,   locale: 'en-IE' },
  'Europe/Oslo':            { lat: 59.9139,  lng: 10.7522,   locale: 'nb-NO' },
  'Europe/Copenhagen':      { lat: 55.6761,  lng: 12.5683,   locale: 'da-DK' },
  'Europe/Brussels':        { lat: 50.8503,  lng: 4.3517,    locale: 'nl-BE' },
  'Europe/Prague':          { lat: 50.0755,  lng: 14.4378,   locale: 'cs-CZ' },
  'Europe/Istanbul':        { lat: 41.0082,  lng: 28.9784,   locale: 'tr-TR' },

  // Africa
  'Africa/Cairo':           { lat: 30.0444,  lng: 31.2357,   locale: 'ar-EG' },
  'Africa/Lagos':           { lat: 6.5244,   lng: 3.3792,    locale: 'en-NG' },
  'Africa/Johannesburg':    { lat: -26.2041, lng: 28.0473,   locale: 'en-ZA' },
  'Africa/Nairobi':         { lat: -1.2921,  lng: 36.8219,   locale: 'sw-KE' },
  'Africa/Casablanca':      { lat: 33.5731,  lng: -7.5898,   locale: 'ar-MA' },

  // Asia / Pacific
  'Asia/Tokyo':             { lat: 35.6762,  lng: 139.6503,  locale: 'ja-JP' },
  'Asia/Shanghai':          { lat: 31.2304,  lng: 121.4737,  locale: 'zh-CN' },
  'Asia/Hong_Kong':         { lat: 22.3193,  lng: 114.1694,  locale: 'zh-HK' },
  'Asia/Singapore':         { lat: 1.3521,   lng: 103.8198,  locale: 'en-SG' },
  'Asia/Seoul':             { lat: 37.5665,  lng: 126.9780,  locale: 'ko-KR' },
  'Asia/Dubai':             { lat: 25.2048,  lng: 55.2708,   locale: 'ar-AE' },
  'Asia/Kolkata':           { lat: 22.5726,  lng: 88.3639,   locale: 'en-IN' },
  'Asia/Bangkok':           { lat: 13.7563,  lng: 100.5018,  locale: 'th-TH' },
  'Asia/Jakarta':           { lat: -6.2088,  lng: 106.8456,  locale: 'id-ID' },
  'Asia/Manila':            { lat: 14.5995,  lng: 120.9842,  locale: 'en-PH' },
  'Asia/Taipei':            { lat: 25.0330,  lng: 121.5654,  locale: 'zh-TW' },
  'Asia/Ho_Chi_Minh':       { lat: 10.8231,  lng: 106.6297,  locale: 'vi-VN' },
  'Asia/Riyadh':            { lat: 24.7136,  lng: 46.6753,   locale: 'ar-SA' },

  // Oceania
  'Australia/Sydney':       { lat: -33.8688, lng: 151.2093,  locale: 'en-AU' },
  'Australia/Melbourne':    { lat: -37.8136, lng: 144.9631,  locale: 'en-AU' },
  'Australia/Brisbane':     { lat: -27.4698, lng: 153.0251,  locale: 'en-AU' },
  'Australia/Perth':        { lat: -31.9505, lng: 115.8605,  locale: 'en-AU' },
  'Pacific/Auckland':       { lat: -36.8485, lng: 174.7633,  locale: 'en-NZ' },
};

/**
 * Resolve a Playwright `geolocation` and `locale` from an IANA timezone ID.
 * Falls back to a longitude-based approximation when the timezone isn't in
 * the lookup table, with "en" as the locale.
 */
function resolveTzGeo(timezoneId: string): { geolocation: { latitude: number; longitude: number }; locale: string } {
  // Exact match
  const entry = TZ_GEO[timezoneId];
  if (entry) {
    return {
      geolocation: { latitude: entry.lat, longitude: entry.lng },
      locale: entry.locale,
    };
  }

  // Try stripping the region prefix for a shorter match (e.g. "US/Eastern" → "America/New_York")
  const altId = timezoneId.replace(/^US\//, 'America/').replace(/^GB\//, 'Europe/');
  const altEntry = TZ_GEO[altId];
  if (altEntry) {
    return {
      geolocation: { latitude: altEntry.lat, longitude: altEntry.lng },
      locale: altEntry.locale,
    };
  }

  // Fallback: derive approximate longitude from the UTC offset implied by the
  // timezone. This won't be exact but at least moves the pin to the right
  // part of the world rather than defaulting to New York.
  try {
    // Use Intl.DateTimeFormat to extract the UTC offset for this timezone
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en', { timeZone: timezoneId, timeZoneName: 'longOffset' });
    const parts = fmt.formatToParts(now);
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (tzPart) {
      const match = tzPart.value.match(/GMT([+-]\d{1,2}):?(\d{2})?/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const mins = parseInt(match[2] ?? '0', 10);
        const offsetHours = hours + mins / 60 * (hours < 0 ? -1 : 1);
        // Crude: 15° longitude per hour of offset, centered on prime meridian
        const lng = offsetHours * 15;
        return {
          geolocation: { latitude: 0, longitude: lng },
          locale: 'en',
        };
      }
    }
  } catch { /* fall through */ }

  // Last resort: UTC
  console.warn(`  ⚠️  Unknown timezone "${timezoneId}", defaulting geolocation to UTC`);
  return {
    geolocation: { latitude: 0, longitude: 0 },
    locale: 'en',
  };
}

async function getBrowser(headless: boolean): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  console.log(`🌐 Launching browser (headless=${headless})...`);
  browserInstance = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--password-store=basic',
      '--use-mock-keychain',
    ],
  });

  browserInstance.on('disconnected', () => {
    console.log('🌐 Browser disconnected');
    browserInstance = null;
  });

  return browserInstance;
}

/**
 * Create an isolated BrowserContext with session data injected.
 * The caller is responsible for closing the context when done.
 *
 * Includes comprehensive anti-detection measures to evade Cloudflare bot detection:
 *  - navigator.webdriver removal
 *  - window.chrome.runtime spoofing
 *  - navigator.plugins and mimeTypes arrays
 *  - WebGL vendor/renderer fingerprint spoofing
 *  - Canvas fingerprint randomization (subtle noise)
 *  - Permissions API spoofing
 *  - Hardware concurrency normalization
 *  - Notification permission handling
 */
export async function createBrowserContext(
  sessionProfile: AccountSessionProfile,
  headless: boolean = true,
  proxy?: ProxyConfig | null,
): Promise<BrowserContext> {
  const browser = await getBrowser(headless);

  // Derive geolocation & locale from the account's actual timezone so the
  // emulated position matches what the timezone implies (Cloudflare checks
  // for consistency between IP geolocation, browser timezone, and reported
  // coordinates).
  const { geolocation, locale } = resolveTzGeo(sessionProfile.timezoneId);

  // Vary viewport slightly per session — real browsers differ by dock, taskbar,
  // zoom, and window sizing.  1920×1080 ± a random ~100px keeps it organic.
  const viewportWidth = jitterVp(1820, 1960);
  const viewportHeight = jitterVp(980, 1120);

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    userAgent: sessionProfile.userAgent,
    timezoneId: sessionProfile.timezoneId,
    viewport: { width: viewportWidth, height: viewportHeight },
    locale,
    // Reduce detection surface
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    // Realistic permissions — matches a typical user browser
    permissions: ['geolocation', 'notifications'],
    geolocation,
    // article: realistic browser config — accept downloads without prompt
    acceptDownloads: true,
  };

  // Attach proxy when configured — rotates IP per job to avoid rate limiting.
  if (proxy) {
    contextOptions.proxy = {
      server: proxy.server,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
    };
    console.log(`  🌐 Using proxy: ${proxy.server.replace(/\/\/.*@/, '//<redacted>@')}`);
  }

  const context = await browser.newContext(contextOptions);

  // ── Anti-detection: remove navigator.webdriver ──────────────────────
  // This is the #1 automation indicator. Cloudflare checks this property.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  // ── Anti-detection: spoof window.chrome ─────────────────────────────
  // Real Chrome has window.chrome with a runtime property. Headless
  // Chromium often omits this. Cloudflare checks for its presence.
  await context.addInitScript(() => {
    (window as any).chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: {},
    };
  });

  // ── Anti-detection: spoof navigator.plugins ──────────────────────────
  // Headless Chromium has an empty plugins array. Real Chrome always has
  // at least the built-in PDF viewer and PDF plugin.
  await context.addInitScript(() => {
    const makePlugin = (name: string, filename: string, description: string, ...mimeTypes: any[]) => ({
      name,
      filename,
      description,
      length: mimeTypes.length,
      item: (i: number) => mimeTypes[i] ?? null,
      namedItem: (n: string) => mimeTypes.find((m: any) => m.type === n) ?? null,
      ...mimeTypes.reduce((acc: any, m: any, i: number) => {
        acc[i] = m;
        acc[m.type] = m;
        return acc;
      }, {}),
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format',
            { type: 'application/pdf', suffixes: 'pdf', description: '' }
          ),
          makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '',
            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
          ),
        ] as any;
        arr.item = (i: number) => arr[i] ?? null;
        arr.namedItem = (n: string) => arr.find((p: any) => p.name === n) ?? null;
        arr.refresh = () => {};
        Object.defineProperty(arr, 'length', { value: arr.length, writable: false });
        return arr;
      },
    });

    // Also spoof mimeTypes — it's linked to plugins and should be non-empty
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const arr = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ] as any;
        arr.item = (i: number) => arr[i] ?? null;
        arr.namedItem = (n: string) => arr.find((m: any) => m.type === n) ?? null;
        Object.defineProperty(arr, 'length', { value: arr.length, writable: false });
        return arr;
      },
    });
  });

  // ── Anti-detection: spoof WebGL fingerprint ──────────────────────────
  // Headless Chromium reports "Google Inc." / "ANGLE" for WebGL. Real
  // Chrome on macOS reports the actual GPU vendor. Cloudflare uses WebGL
  // renderer strings as part of its fingerprinting.
  await context.addInitScript(() => {
    const overrideWebGL = (prototype: any) => {
      const origGetParameter = prototype.getParameter;
      prototype.getParameter = function (parameter: number) {
        // UNMASKED_VENDOR_WEBGL (0x9245 / 37445)
        if (parameter === 37445) {
          return 'Intel Inc.';
        }
        // UNMASKED_RENDERER_WEBGL (0x9246 / 37446)
        if (parameter === 37446) {
          return 'Intel Iris OpenGL Engine';
        }
        return origGetParameter.call(this, parameter);
      };
    };

    try {
      overrideWebGL(WebGLRenderingContext.prototype);
    } catch {}
    try {
      overrideWebGL(WebGL2RenderingContext.prototype);
    } catch {}
  });

  // ── Anti-detection: canvas fingerprint randomization ────────────────
  // Adds subtle per-pixel noise to canvas outputs so repeated renders
  // produce slightly different hashes, defeating canvas fingerprinting.
  await context.addInitScript(() => {
    const addNoise = (ctx: CanvasRenderingContext2D) => {
      try {
        const imageData = ctx.getImageData(
          0,
          0,
          ctx.canvas.width,
          ctx.canvas.height,
        );
        for (let i = 0; i < imageData.data.length; i += 4) {
          // ±1 on each RGB channel — visually imperceptible, destroys hash
          imageData.data[i] += Math.floor(Math.random() * 3) - 1;
          imageData.data[i + 1] += Math.floor(Math.random() * 3) - 1;
          imageData.data[i + 2] += Math.floor(Math.random() * 3) - 1;
        }
        ctx.putImageData(imageData, 0, 0);
      } catch {
        // Ignore if canvas is tainted or unreadable
      }
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (
      type?: string,
      quality?: number,
    ): string {
      try {
        const ctx = this.getContext('2d', { willReadFrequently: true });
        if (ctx) addNoise(ctx);
      } catch {}
      return origToDataURL.call(this, type, quality);
    };

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      callback: BlobCallback | null,
      type?: string,
      quality?: number,
    ): void {
      try {
        const ctx = this.getContext('2d', { willReadFrequently: true });
        if (ctx) addNoise(ctx);
      } catch {}
      return origToBlob.call(this, callback!, type, quality);
    };
  });

  // ── Anti-detection: hardware concurrency normalization ────────────────
  // Some headless environments report unusual core counts. 4-8 is typical.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 4,
    });
  });

  // ── Anti-detection: device memory ──────────────────────────────────
  // Headless Chromium may report 0 or a very low value. Real desktops
  // report 4-8 GB. Cloudflare checks this as part of fingerprinting.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });
  });

  // ── Anti-detection: max touch points ───────────────────────────────
  // Desktops should report 0. A non-zero value implies a touch device
  // which would mismatch a macOS user agent.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
    });
  });

  // ── Anti-detection: permissions API ─────────────────────────────────
  // Spoof permission queries so the page sees expected states for
  // notifications, camera, microphone, etc.
  await context.addInitScript(() => {
    const origQuery = (window.Permissions?.prototype as any)?.query;
    if (origQuery) {
      const PermissionsPrototype = window.Permissions?.prototype as any;
      PermissionsPrototype.query = function (desc: PermissionDescriptor) {
        return origQuery
          .call(this, desc)
          .then((status: PermissionStatus) => {
            // Let geolocation/notifications through as "prompt" (realistic)
            if (desc.name === 'notifications' || desc.name === 'geolocation') {
              Object.defineProperty(status, 'state', {
                get: () => 'prompt',
              });
            }
            return status;
          });
      };
    }
  });

  // ── Anti-detection: battery API removal ──────────────────────────────
  // Headless Chrome may expose unusual battery status. Disable it.
  await context.addInitScript(() => {
    (navigator as any).getBattery = undefined;
  });

  // Inject cookies
  const cookies = sessionProfile.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));

  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  // Inject localStorage via addInitScript — this runs before any page JS
  if (Object.keys(sessionProfile.localStorageSnapshot).length > 0) {
    await context.addInitScript(
      (snapshot: Record<string, string>) => {
        for (const [key, value] of Object.entries(snapshot)) {
          try {
            localStorage.setItem(key, value);
          } catch {
            // localStorage may not be available in all contexts
          }
        }
      },
      sessionProfile.localStorageSnapshot,
    );
  }

  return context;
}

/**
 * Shut down the shared browser instance (for graceful shutdown).
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance && browserInstance.isConnected()) {
    await browserInstance.close();
    browserInstance = null;
  }
}
