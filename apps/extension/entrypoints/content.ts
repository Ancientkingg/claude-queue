import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { QueueButton } from '@/components/QueueButton';
// NOTE: No CSS import — injecting utilities into claude.ai's <head> would
// conflict with their CSS modules and blank the page. Inline styles only.

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  cssInjectionMode: 'manifest',

  async main(_ctx) {
    console.log('[Claude Queue] Content script loaded');

    // Answer GET_LOCAL_STORAGE requests from the background script.
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

    await waitForAnyContent(15000);

    // Single React root, reused across re-anchors so modal/button state survives.
    const wrapper = document.createElement('span');
    wrapper.id = 'claude-queue-root';
    wrapper.style.cssText =
      'display:inline-flex;align-items:center;vertical-align:middle;flex-shrink:0;';
    const root: Root = createRoot(wrapper);
    root.render(React.createElement(QueueButton));

    // Insert (or re-insert) the wrapper right after the mic button so it sits
    // between the mic and the wave/send button.
    const ensureMounted = () => {
      if (wrapper.isConnected) return;
      const mic = findMicButton();
      if (mic) {
        // The mic lives inside a hover-styled group container (it darkens and
        // reveals a mic-only settings popout). Inserting next to the mic button
        // puts us *inside* that group. Instead insert after the whole group
        // wrapper (two levels up) as a sibling in the toolbar row, so the Queue
        // button sits between the mic group and the wave button, on its own.
        const groupWrapper = mic.parentElement?.parentElement;
        const row = groupWrapper?.parentElement;
        if (groupWrapper && row && groupWrapper.parentElement === row) {
          row.insertBefore(wrapper, groupWrapper.nextSibling);
          return;
        }
        if (mic.parentElement) {
          mic.parentElement.insertBefore(wrapper, mic.nextSibling);
          return;
        }
      }
      // Fallback: keep the button usable even if the mic can't be found.
      const fallback = findSendButton() ?? document.querySelector('[contenteditable="true"]');
      if (fallback && fallback.parentElement && !wrapper.isConnected) {
        fallback.parentElement.insertBefore(wrapper, fallback);
      }
    };

    ensureMounted();

    // claude.ai re-renders the toolbar (notably the wave↔send swap on typing),
    // which can detach our node. Re-anchor whenever that happens, debounced.
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        ensureMounted();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[Claude Queue] UI mounted');
  },
});

/**
 * Find claude.ai's microphone (dictation) button — labelled "Press and hold to
 * record". It sits just left of the "Use voice mode" wave button, so inserting
 * after it places the Queue button between the mic and the wave/send button.
 * Note: we deliberately avoid matching "voice", which is the wave button.
 */
function findMicButton(): HTMLElement | null {
  const SELECTORS = [
    'button[aria-label*="record" i]',      // "Press and hold to record"
    'button[aria-label*="dictation" i]',
    'button[aria-label*="microphone" i]',
  ];
  for (const sel of SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  // Fallback: scan toolbar buttons for a mic-like aria-label (not the wave btn).
  for (const btn of document.querySelectorAll<HTMLElement>('button[aria-label]')) {
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    if (/record|dicta|microphone/.test(label)) return btn;
  }
  return null;
}

/** Find a send/submit button as a placement fallback. */
function findSendButton(): HTMLElement | null {
  const SELECTORS = [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button[data-testid="send-button"]',
    'button[type="submit"]',
  ];
  for (const sel of SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

/** Resolve once the SPA has rendered real content into #root. */
function waitForAnyContent(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const root = document.getElementById('root');
      return !!(
        root &&
        root.children.length > 0 &&
        root.textContent &&
        root.textContent.trim().length > 20
      );
    };
    if (check()) return resolve();

    let settled = false;
    const done = () => { settled = true; clearTimeout(timer); obs.disconnect(); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    const obs = new MutationObserver(() => { if (!settled && check()) done(); });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}
