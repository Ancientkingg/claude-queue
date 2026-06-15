import { createRoot } from 'react-dom/client';
import React from 'react';
import { QueueButton } from '@/components/QueueButton';
import '@/assets/content.css';

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    console.log('[Claude Queue] Content script loaded on claude.ai');

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

    // Find a suitable anchor — Claude.ai is a React SPA so we must wait for render
    const anchor = await findAnchor();

    const ui = await createIntegratedUi(ctx, {
      name: 'claude-queue-button',
      position: 'inline',
      anchor: anchor ?? document.body,
      append: anchor ? 'before' : 'last',
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
 * Find a suitable anchor element on claude.ai.
 * The page is a React SPA — all DOM is rendered dynamically.
 */
async function findAnchor(): Promise<Element | null> {
  const SELECTORS = [
    // Claude.ai send button
    'button[aria-label="Send Message"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    // Any submit button inside a form (chat input bar)
    'form button[type="submit"]',
    // Contenteditable input areas (the prompt box)
    '[contenteditable="true"]',
    '[data-placeholder]',
    // Textareas
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Claude" i]',
    // ProseMirror editor (used by some chat UIs)
    '.ProseMirror',
    'div[class*="ProseMirror"]',
  ];

  for (const selector of SELECTORS) {
    const el = await waitForElement(selector, 8000);
    if (el) {
      console.log(`[Claude Queue] Anchor found: "${selector}"`);
      return el;
    }
  }

  console.warn('[Claude Queue] No anchor found — injecting at end of body');
  return null;
}

/**
 * Wait for a DOM element matching `selector` to appear.
 * Returns null on timeout instead of throwing.
 */
function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

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
