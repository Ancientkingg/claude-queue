import { createRoot } from 'react-dom/client';
import React from 'react';
import { QueueButton } from '@/components/QueueButton';
// NOTE: No CSS import — injecting Tailwind utilities into claude.ai's <head>
// would conflict with their CSS modules and break the page.

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  cssInjectionMode: 'manifest', // don't auto-inject any CSS

  async main(ctx) {
    console.log('[Claude Queue] Content script loaded');

    // Handle GET_LOCAL_STORAGE requests from the background script
    browser.runtime.onMessage.addListener(
      (message: { type: string }, _sender, sendResponse) => {
        if (message.type === 'GET_LOCAL_STORAGE') {
          const snapshot: Record<string, string> = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key) {
                snapshot[key] = localStorage.getItem(key) ?? '';
              }
            }
          } catch {
            // localStorage may be restricted
          }
          sendResponse(snapshot);
          return false;
        }
        return false;
      },
    );

    // Wait for Claude's React SPA to render
    const anchor = await findAnchor();

    const ui = await createIntegratedUi(ctx, {
      name: 'claude-queue-button',
      position: 'inline',
      anchor: anchor ?? document.body,
      append: 'before',
      onMount(container: HTMLElement) {
        const wrapper = document.createElement('span');
        wrapper.id = 'claude-queue-root';
        wrapper.style.cssText =
          'display:inline-flex;align-items:center;vertical-align:middle;flex-shrink:0;';
        container.append(wrapper);

        const root = createRoot(wrapper);
        root.render(React.createElement(QueueButton));
        return root;
      },
      onRemove(root: any) {
        root?.unmount();
      },
    });

    ui.mount();
    console.log('[Claude Queue] UI mounted');
  },
});

/**
 * Find the Send button or input area on claude.ai.
 * Tries multiple selectors — page is a React SPA so we must poll.
 */
async function findAnchor(): Promise<Element | null> {
  const SELECTORS = [
    'button[aria-label="Send Message"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'form button[type="submit"]',
    '[contenteditable="true"]',
    '[data-placeholder]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Claude" i]',
    '.ProseMirror',
    'div[class*="ProseMirror"]',
  ];

  for (const sel of SELECTORS) {
    const el = await waitForElement(sel, 8000);
    if (el) {
      console.log(`[Claude Queue] Anchor: "${sel}"`);
      return el;
    }
  }

  console.warn('[Claude Queue] No anchor found, appending to body');
  return null;
}

function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    let settled = false;
    const done = (el: Element | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve(el);
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) done(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
