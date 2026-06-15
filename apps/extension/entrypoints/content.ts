import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { QueueButton } from '@/components/QueueButton';
import { QueuedBubbles } from '@/components/QueuedBubbles';
import { QueuedSidebar } from '@/components/QueuedSidebar';
import { PseudoChat } from '@/components/PseudoChat';
import { QueueStore, type QueuedJob } from '@/lib/queue-store';
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

    // Shared store of this account's PENDING jobs, fed by the background.
    const store = new QueueStore(async () => {
      const res = await browser.runtime.sendMessage({ type: 'LIST_QUEUED_JOBS' });
      return res?.ok ? (res.jobs as QueuedJob[]) : [];
    });
    store.startPolling(10_000);

    // Emit a 'cq:nav' event whenever the SPA URL changes (history + popstate).
    let lastHref = location.href;
    const fireNav = () => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        window.dispatchEvent(new CustomEvent('cq:nav'));
        void store.refresh();
      }
    };
    for (const m of ['pushState', 'replaceState'] as const) {
      const orig = history[m];
      history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
        const r = orig.apply(this, args);
        fireNav();
        return r;
      } as History[typeof m];
    }
    window.addEventListener('popstate', fireNav);

    // Single React root, reused across re-anchors so modal/button state survives.
    const wrapper = document.createElement('span');
    wrapper.id = 'claude-queue-root';
    wrapper.style.cssText =
      'display:inline-flex;align-items:center;vertical-align:middle;flex-shrink:0;';
    const root: Root = createRoot(wrapper);
    root.render(React.createElement(QueueButton, { onQueued: (j: QueuedJob) => store.addOptimistic(j) }));

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

    mountQueuedBubbles(store);
    mountQueuedSidebar(store);
    mountPseudoChat(store);

    // Dispatch an initial nav event so all useLocationPath hooks sync to the
    // current URL immediately, even before the first SPA navigation fires.
    window.dispatchEvent(new CustomEvent('cq:nav'));

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

function mountQueuedBubbles(store: QueueStore) {
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-queue-bubbles';
  wrapper.style.cssText = 'width:100%;';
  const root = createRoot(wrapper);
  root.render(React.createElement(QueuedBubbles, { store }));

  let retries = 0;
  const MAX_RETRIES = 30; // ~15s at 500ms intervals

  const ensure = () => {
    if (wrapper.isConnected) return;
    // Anchor: inside the message scroll container at the end of the thread,
    // before the sticky chat input. Search the scroll container itself (not
    // just its first child) for the input — it may be nested several levels
    // deep inside the scroll div.
    const scroll = document.querySelector('[data-autoscroll-container="true"]');
    if (!scroll) {
      // SPA may not have rendered the chat area yet — retry with backoff.
      if (retries < MAX_RETRIES) {
        retries++;
        setTimeout(ensure, 500);
      }
      return;
    }
    retries = 0; // found the container, reset retries for future re-anchors
    const inputContainer = scroll.querySelector('[data-chat-input-container="true"]');
    if (inputContainer) {
      scroll.insertBefore(wrapper, inputContainer);
    } else {
      scroll.appendChild(wrapper);
    }
  };
  ensure();
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensure(); });
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function mountQueuedSidebar(store: QueueStore) {
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-queue-sidebar';
  const root = createRoot(wrapper);
  root.render(React.createElement(QueuedSidebar, { store }));

  const ensure = () => {
    if (wrapper.isConnected) return;
    const nav = document.querySelector('nav[aria-label="Sidebar"]');
    if (!nav) return;

    // Anchor between the Products section and the Recents section.
    // claude.ai renders section headers as <h2 class="contents"> containing a
    // <span role="button"> whose textContent includes the section name plus an
    // icon character (e.g. "Recents"), so we can't use exact match.
    // Strategy: find the <h2> whose text starts with "Recents", then walk up
    // to the <div class="flex-1 relative"> that wraps the entire Recents block.
    const headings = nav.querySelectorAll('h2');
    for (const h2 of headings) {
      const text = h2.textContent?.trim() ?? '';
      if (text.startsWith('Recents')) {
        // Walk up to the <div class="flex-1 relative"> that is the Recents
        // section's outer container — it lives at the same level as the
        // Products <ul> in the sidebar's scroll area.
        const recentsBlock = h2.closest('div.flex-1.relative') as HTMLElement | null;
        if (recentsBlock?.parentElement) {
          recentsBlock.parentElement.insertBefore(wrapper, recentsBlock);
          return;
        }
        // Fallback: the h2 is inside a series of nested divs; go up 4 levels
        // to reach the top-level section wrapper.
        let el: HTMLElement | null = h2;
        for (let i = 0; i < 4 && el; i++) el = el.parentElement;
        if (el?.parentElement) {
          el.parentElement.insertBefore(wrapper, el);
          return;
        }
      }
    }

    // Fallback: insert after the Products section.
    for (const h2 of headings) {
      const text = h2.textContent?.trim() ?? '';
      if (text.startsWith('Products')) {
        const productsBlock = (h2.closest('ul')?.parentElement ?? h2.parentElement?.parentElement?.parentElement) as HTMLElement | null;
        if (productsBlock?.parentElement) {
          productsBlock.parentElement.insertBefore(wrapper, productsBlock.nextSibling);
          return;
        }
      }
    }

    // Last resort: anchor before the "Chats" link.
    const chatsLink = document.querySelector('nav a[href="/recents"]');
    if (chatsLink) {
      const list = chatsLink.parentElement;
      if (list?.parentElement) {
        list.parentElement.insertBefore(wrapper, list);
        return;
      }
    }
    // Ultimate fallback: top of scroll area.
    const scrollArea = nav.children[1] ?? nav.firstElementChild;
    if (scrollArea) {
      scrollArea.insertBefore(wrapper, scrollArea.firstChild);
    }
  };
  ensure();
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensure(); });
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function mountPseudoChat(store: QueueStore) {
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-queue-pseudo';
  document.body.appendChild(wrapper);
  createRoot(wrapper).render(React.createElement(PseudoChat, { store }));
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
