import type { AccountSessionProfile } from '@claude-queue/shared-types';

/**
 * Harvests the current session profile from claude.ai.
 * Must be called from the background script context (has access to browser.cookies).
 * Requires a content script message to retrieve localStorage.
 */
export async function harvestSession(): Promise<AccountSessionProfile> {
  // Get all cookies for claude.ai
  const rawCookies = await browser.cookies.getAll({ domain: '.claude.ai' });

  const cookies = rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));

  // Get user agent from any active tab (injecting a script)
  const userAgent = await getUserAgent();

  // Get localStorage from the content script
  const localStorageSnapshot = await getLocalStorageFromContentScript();

  // Get timezone
  const timezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    cookies,
    userAgent,
    localStorageSnapshot,
    timezoneId,
  };
}

/**
 * Retrieve the userAgent by querying the active claude.ai tab.
 */
async function getUserAgent(): Promise<string> {
  try {
    const tabs = await browser.tabs.query({
      url: 'https://claude.ai/*',
      active: true,
      currentWindow: true,
    });

    if (tabs.length > 0 && tabs[0]?.id != null) {
      const results = await browser.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => navigator.userAgent,
      });
      if (results?.[0]?.result) {
        return results[0].result as string;
      }
    }
  } catch {
    // Fall back to a generic UA if scripting fails
  }

  // Fallback: navigator is available in service worker in some browsers
  return typeof navigator !== 'undefined'
    ? navigator.userAgent
    : 'Mozilla/5.0 (compatible; ClaudeQueue/1.0)';
}

/**
 * Ask the content script in the active claude.ai tab for localStorage data.
 */
async function getLocalStorageFromContentScript(): Promise<
  Record<string, string>
> {
  try {
    const tabs = await browser.tabs.query({
      url: 'https://claude.ai/*',
      active: true,
      currentWindow: true,
    });

    if (tabs.length > 0 && tabs[0]?.id != null) {
      const response = await browser.tabs.sendMessage(tabs[0].id, {
        type: 'GET_LOCAL_STORAGE',
      });
      if (response && typeof response === 'object') {
        return response as Record<string, string>;
      }
    }
  } catch {
    // Content script may not be loaded yet
  }

  return {};
}

/**
 * Harvest a dedicated worker session from an incognito (private browsing)
 * window. This creates a completely separate cookie jar — logging into
 * claude.ai here creates a fresh session token that won't overwrite or
 * invalidate the user's interactive session.
 *
 * Flow:
 *  1. Open an incognito popup to claude.ai/login
 *  2. Wait for the user to complete login (URL leaves /login)
 *  3. Harvest cookies from the incognito cookie store
 *  4. Harvest localStorage from the popup tab
 *  5. Close the incognito window
 *  6. Return AccountSessionProfile with the fresh credentials
 *
 * Throws if the user closes the popup or login times out.
 */
export async function harvestWorkerSession(): Promise<AccountSessionProfile> {
  // 1. Open incognito popup
  const popup = await browser.windows.create({
    url: 'https://claude.ai/login?returnTo=/new',
    type: 'popup',
    width: 600,
    height: 700,
    incognito: true,
  });

  if (!popup) {
    throw new Error('Failed to open incognito popup');
  }

  const popupId = popup.id;
  const popupTab = popup.tabs?.[0];
  if (!popupId || !popupTab?.id) {
    throw new Error('Failed to open incognito popup');
  }

  try {
    // 2. Wait for login to complete
    await waitForLoginComplete(popupTab.id);

    // 3. Find the incognito cookie store
    const stores = await browser.cookies.getAllCookieStores();
    const incognitoStore = stores.find((s) => (s as any).incognito === true);
    if (!incognitoStore) {
      throw new Error('Could not find incognito cookie store');
    }

    // 4. Harvest cookies from the incognito store only
    const rawCookies = await browser.cookies.getAll({
      domain: '.claude.ai',
      storeId: incognitoStore.id,
    });

    const cookies = rawCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    }));

    // 5. Get user agent from the popup tab
    let userAgent = 'Mozilla/5.0 (compatible; ClaudeQueue/1.0)';
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: popupTab.id },
        func: () => navigator.userAgent,
      });
      if (results?.[0]?.result) {
        userAgent = results[0].result as string;
      }
    } catch { /* fallback */ }

    // 6. Get localStorage from the popup via content script
    let localStorageSnapshot: Record<string, string> = {};
    try {
      // Give the SPA a moment to initialise after login
      await new Promise((r) => setTimeout(r, 1_500));
      const response = await browser.tabs.sendMessage(popupTab.id, {
        type: 'GET_LOCAL_STORAGE',
      });
      if (response && typeof response === 'object') {
        localStorageSnapshot = response as Record<string, string>;
      }
    } catch { /* content script may not be loaded yet */ }

    // 7. Timezone (from background context)
    const timezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return {
      cookies,
      userAgent,
      localStorageSnapshot,
      timezoneId,
    };
  } finally {
    // 8. Always close the incognito popup
    try {
      await browser.windows.remove(popupId);
    } catch { /* window may already be closed */ }
  }
}

/**
 * Poll the popup tab until the URL indicates login is complete.
 * claude.ai redirects from /login to /new or /chat/... after successful auth.
 */
async function waitForLoginComplete(
  tabId: number,
  timeoutMs: number = 120_000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (!tab.url) continue;

      // Login is complete when we're on claude.ai and NOT on the /login page
      if (
        tab.url.startsWith('https://claude.ai/') &&
        !tab.url.includes('/login')
      ) {
        return;
      }
    } catch {
      // Tab closed by the user
      throw new Error('Login window was closed before completing login');
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Login timed out. Please try again.');
}
