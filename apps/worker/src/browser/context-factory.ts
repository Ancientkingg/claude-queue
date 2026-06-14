import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { AccountSessionProfile } from '@claude-queue/shared-types';

// We keep a singleton browser instance to avoid re-launching Chromium for every job.
// Each job gets its own isolated BrowserContext.
let browserInstance: Browser | null = null;

async function getBrowser(headless: boolean): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  console.log(`🌐 Launching browser (headless=${headless})...`);
  browserInstance = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
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
 */
export async function createBrowserContext(
  sessionProfile: AccountSessionProfile,
  headless: boolean = true,
): Promise<BrowserContext> {
  const browser = await getBrowser(headless);

  const context = await browser.newContext({
    userAgent: sessionProfile.userAgent,
    timezoneId: sessionProfile.timezoneId,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    // Reduce detection surface
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
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
