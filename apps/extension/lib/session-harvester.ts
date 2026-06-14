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
