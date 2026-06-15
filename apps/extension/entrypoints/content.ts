import { createRoot } from 'react-dom/client';
import React from 'react';
import { QueueButton } from '@/components/QueueButton';
import '@/assets/styles.css';

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

    // Wait for the Claude chat UI to load, then inject the Queue button
    await waitForElement(
      'button[aria-label="Send Message"], button[data-testid="send-button"], form button[type="submit"]',
    );

    const ui = await createShadowRootUi(ctx, {
      name: 'claude-queue-button',
      position: 'inline',
      anchor:
        'button[aria-label="Send Message"], button[data-testid="send-button"], form button[type="submit"]',
      append: 'before',
      onMount(container: any) {
        const wrapper = document.createElement('div');
        wrapper.id = 'claude-queue-root';
        wrapper.style.display = 'inline-flex';
        wrapper.style.alignItems = 'center';
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
  },
});

/**
 * Wait for a DOM element to appear (polling with MutationObserver fallback).
 */
function waitForElement(selector: string, timeoutMs = 30000): Promise<Element> {
  return new Promise((resolve, reject) => {
    // Check if already present
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(
        new Error(
          `[Claude Queue] Timed out waiting for element: ${selector}`,
        ),
      );
    }, timeoutMs);

    const observer = new MutationObserver((_mutations, obs) => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timeout);
        obs.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}
