import { createRoot } from 'react-dom/client';
import React from 'react';
import { QueueButton } from '@/components/QueueButton';
// NOTE: No CSS import — injecting Tailwind utilities into claude.ai's <head>
// would conflict with their CSS modules and break the page.

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  cssInjectionMode: 'manifest',

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
              if (key) snapshot[key] = localStorage.getItem(key) ?? '';
            }
          } catch { /* restricted */ }
          sendResponse(snapshot);
          return false;
        }
        return false;
      },
    );

    // Wait for SPA to render, then find the best anchor
    const { anchor, append } = await findBestAnchor();
    console.log('[Claude Queue] Anchor:', anchor?.tagName, 'append:', append);

    const ui = await createIntegratedUi(ctx, {
      name: 'claude-queue-button',
      position: 'inline',
      anchor,
      append,
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
 * Find the best anchor for button placement on claude.ai.
 *
 * Priority:
 * 1. Send button (best) — insert BEFORE it so Queue button sits left of Send
 * 2. Contenteditable — insert AFTER it (right of text area, still in toolbar)
 * 3. Fallback: document.body
 */
async function findBestAnchor(): Promise<{ anchor: Element; append: 'before' | 'after' }> {
  await waitForAnyContent(15000);
  console.log('[Claude Queue] Page rendered, searching for anchor...');

  // Priority 1: find the send button and insert before it
  const sendBtn = await findSendButton(10000);
  if (sendBtn) {
    console.log('[Claude Queue] Found send button');
    return { anchor: sendBtn, append: 'before' };
  }

  // Priority 2: find the contenteditable and insert after it
  const editable = await waitForElement('[contenteditable="true"]', 8000);
  if (editable) {
    console.log('[Claude Queue] Found contenteditable');
    return { anchor: editable, append: 'after' };
  }

  // Priority 3: any textarea
  const textarea = await waitForElement('textarea', 5000);
  if (textarea) {
    console.log('[Claude Queue] Found textarea');
    return { anchor: textarea, append: 'after' };
  }

  console.warn('[Claude Queue] No anchor found — appending to body');
  return { anchor: document.body, append: 'after' };
}

/**
 * Try to find a send/submit button on the page.
 */
async function findSendButton(timeoutMs: number): Promise<Element | null> {
  const SELECTORS = [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button[data-testid="send-button"]',
    'button[type="submit"]',
  ];

  // Race all send button selectors
  const result = await Promise.race(
    SELECTORS.map((sel) => waitForElement(sel, timeoutMs)),
  );

  if (result) return result;

  // Fallback: scan all buttons for send-like ones
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    const text = (btn.textContent ?? '').toLowerCase().trim();
    if (label.includes('send') || label.includes('submit') || text === 'send' || text === '→') {
      return btn;
    }
  }

  return null;
}

/**
 * Wait for any real content to appear in the #root div.
 */
function waitForAnyContent(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const root = document.getElementById('root');
      if (root && root.children.length > 0 && root.textContent && root.textContent.trim().length > 20) {
        resolve();
        return true;
      }
      return false;
    };

    if (check()) return;

    let settled = false;
    const done = () => { settled = true; clearTimeout(timer); obs.disconnect(); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    const obs = new MutationObserver(() => { if (!settled && check()) done(); });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Wait for a single DOM element matching `selector` to appear.
 */
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
