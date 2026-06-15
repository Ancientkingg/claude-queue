# Extension Queue UI Redesign & Session-Reset Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the claude.ai Queue button between the mic and wave/send buttons (and keep it there), redesign the Queue modal, and add an "end of session" scheduling mode that fires at the usage-limit reset + configurable offset + random jitter.

**Architecture:** All work is in `apps/extension`. The background script passively reads claude.ai's `anthropic-ratelimit-unified-5h-reset` response header via `webRequest.onHeadersReceived` and persists it. The modal reads that reset time and resolves "end of session" into a single absolute `scheduledFor` ISO timestamp — so the API/worker are untouched. Button placement anchors on the always-present mic button with a persistent re-anchor observer.

**Tech Stack:** WXT, React 18, TypeScript, `webRequest`/`storage` WebExtension APIs, Vitest (added here for the pure-logic unit tests).

---

## File Structure

- `apps/extension/lib/reset-parser.ts` (new) — pure functions: parse reset header → epoch ms; compute send time from reset + offset + jitter. Fully unit-tested, no DOM/browser deps.
- `apps/extension/lib/reset-parser.test.ts` (new) — Vitest tests for the above.
- `apps/extension/vitest.config.ts` (new) — node-env Vitest config.
- `apps/extension/lib/storage.ts` (modify) — add `getResetInfo` / `setResetInfo`.
- `apps/extension/entrypoints/background.ts` (modify) — `onHeadersReceived` capture + `GET_RESET_TIME` handler.
- `apps/extension/wxt.config.ts` (modify) — add `webRequest` permission.
- `apps/extension/entrypoints/content.ts` (rewrite) — mic-anchored placement + persistent re-anchor observer.
- `apps/extension/components/ScheduleModal.tsx` (rewrite) — redesigned UI, two modes (Specific time / End of session).
- `apps/extension/components/QueueButton.tsx` (modify) — `GET_RESET_TIME` is owned by the modal; button styling stays, minor tidy only.

---

## Task 1: Vitest setup + reset-parser pure logic (TDD)

**Files:**
- Create: `apps/extension/vitest.config.ts`
- Create: `apps/extension/lib/reset-parser.test.ts`
- Create: `apps/extension/lib/reset-parser.ts`
- Modify: `apps/extension/package.json` (add `vitest` devDep + `test` script)

- [ ] **Step 1: Add Vitest to the extension package**

Run:
```bash
pnpm --filter @claude-queue/extension add -D vitest
```
Expected: `vitest` added to `apps/extension/package.json` devDependencies.

- [ ] **Step 2: Add a `test` script**

In `apps/extension/package.json`, add to `"scripts"`:
```json
    "test": "vitest run"
```

- [ ] **Step 3: Create `apps/extension/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Write the failing test `apps/extension/lib/reset-parser.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseResetHeader, computeSendTime } from './reset-parser';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

describe('parseResetHeader', () => {
  it('parses epoch seconds', () => {
    const future = Math.floor((NOW + 3_600_000) / 1000); // +1h, in seconds
    expect(parseResetHeader(String(future), NOW)).toBe(future * 1000);
  });

  it('parses epoch milliseconds', () => {
    const future = NOW + 3_600_000;
    expect(parseResetHeader(String(future), NOW)).toBe(future);
  });

  it('parses RFC-3339', () => {
    const iso = '2026-06-15T19:00:00.000Z';
    expect(parseResetHeader(iso, NOW)).toBe(Date.parse(iso));
  });

  it('returns null for empty / garbage / nullish', () => {
    expect(parseResetHeader('', NOW)).toBeNull();
    expect(parseResetHeader('   ', NOW)).toBeNull();
    expect(parseResetHeader('not-a-date', NOW)).toBeNull();
    expect(parseResetHeader(null, NOW)).toBeNull();
    expect(parseResetHeader(undefined, NOW)).toBeNull();
  });

  it('rejects timestamps far in the past', () => {
    const longAgo = Math.floor((NOW - 48 * 3_600_000) / 1000);
    expect(parseResetHeader(String(longAgo), NOW)).toBeNull();
  });

  it('rejects timestamps absurdly far in the future', () => {
    const farFuture = Math.floor((NOW + 60 * 24 * 3_600_000) / 1000);
    expect(parseResetHeader(String(farFuture), NOW)).toBeNull();
  });
});

describe('computeSendTime', () => {
  it('adds offset + jitter to a future reset', () => {
    const reset = NOW + 3_600_000;
    const out = computeSendTime(reset, 120_000, 90_000, NOW, () => 0.5);
    expect(out).toBe(reset + 120_000 + 45_000);
  });

  it('keeps jitter within [0, max)', () => {
    const reset = NOW + 3_600_000;
    expect(computeSendTime(reset, 0, 90_000, NOW, () => 0)).toBe(reset);
    expect(computeSendTime(reset, 0, 90_000, NOW, () => 0.999999)).toBeLessThan(reset + 90_000);
  });

  it('schedules from now when the reset is already in the past', () => {
    const reset = NOW - 3_600_000;
    const out = computeSendTime(reset, 120_000, 90_000, NOW, () => 0);
    expect(out).toBe(NOW + 120_000);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @claude-queue/extension test`
Expected: FAIL — cannot resolve `./reset-parser` / functions not defined.

- [ ] **Step 6: Implement `apps/extension/lib/reset-parser.ts`**

```ts
/**
 * Pure helpers for turning claude.ai's rate-limit reset header into an absolute
 * send time. No DOM or browser-API dependencies — unit-tested in isolation.
 */

export interface ResetInfo {
  /** Absolute epoch milliseconds when the 5-hour usage window resets. */
  resetAtMs: number;
  /** Epoch milliseconds when this value was captured (for staleness display). */
  capturedAtMs: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/**
 * Parse an `anthropic-ratelimit-unified-*-reset` header value into epoch ms.
 * Accepts epoch seconds, epoch milliseconds, or an RFC-3339 / ISO string.
 * Returns null for anything unparseable or implausible.
 */
export function parseResetHeader(
  raw: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let ms: number | null = null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    // < 1e12 ⇒ epoch seconds (10-digit era); otherwise already milliseconds.
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    const parsed = Date.parse(trimmed);
    ms = Number.isNaN(parsed) ? null : parsed;
  }

  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < nowMs - ONE_DAY_MS) return null;        // too far in the past
  if (ms > nowMs + THIRTY_DAYS_MS) return null;     // implausibly far ahead
  return ms;
}

/**
 * Compute the absolute send time for "end of session" mode:
 *   base (reset, or now if reset already passed) + offset + random jitter.
 */
export function computeSendTime(
  resetAtMs: number,
  offsetMs: number,
  maxJitterMs: number,
  nowMs: number = Date.now(),
  rng: () => number = Math.random,
): number {
  const base = resetAtMs > nowMs ? resetAtMs : nowMs;
  const jitter = Math.floor(rng() * Math.max(0, maxJitterMs));
  return base + Math.max(0, offsetMs) + jitter;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @claude-queue/extension test`
Expected: PASS — all `parseResetHeader` and `computeSendTime` cases green.

- [ ] **Step 8: Commit**

```bash
git add apps/extension/vitest.config.ts apps/extension/lib/reset-parser.ts apps/extension/lib/reset-parser.test.ts apps/extension/package.json
git commit -m "feat(extension): add reset-header parser + send-time helpers with tests"
```

---

## Task 2: Storage for reset info

**Files:**
- Modify: `apps/extension/lib/storage.ts`

- [ ] **Step 1: Add the import + storage key**

At the top of `apps/extension/lib/storage.ts`, after the existing key constants block, add:
```ts
import type { ResetInfo } from './reset-parser';
```
and add the key alongside the others:
```ts
const RESET_INFO_KEY = 'local:resetInfo';
```

- [ ] **Step 2: Add getter + setter (place after the existing account getters/setters)**

```ts
// --- Usage-reset info (captured from claude.ai rate-limit headers) ---

export async function getResetInfo(): Promise<ResetInfo | null> {
  return storage.getItem<ResetInfo>(RESET_INFO_KEY);
}

export async function setResetInfo(info: ResetInfo): Promise<void> {
  await storage.setItem(RESET_INFO_KEY, info);
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm --filter @claude-queue/extension exec tsc --noEmit -p .`
Expected: no errors from `storage.ts` (pre-existing unrelated errors, if any, are out of scope — note them but do not fix here).

- [ ] **Step 4: Commit**

```bash
git add apps/extension/lib/storage.ts
git commit -m "feat(extension): persist captured usage-reset info in storage"
```

---

## Task 3: Manifest permission + background header capture

**Files:**
- Modify: `apps/extension/wxt.config.ts`
- Modify: `apps/extension/entrypoints/background.ts`

- [ ] **Step 1: Add `webRequest` permission**

In `apps/extension/wxt.config.ts`, change the `permissions` array:
```ts
    permissions: ['cookies', 'storage', 'activeTab', 'webRequest'],
```
(Leave `host_permissions: ['https://claude.ai/*']` as-is — already present.)

- [ ] **Step 2: Wire imports in `background.ts`**

In `apps/extension/entrypoints/background.ts`, extend the storage import to include the reset helpers, and import the parser:
```ts
import {
  getAccountId,
  setAccountId,
  setAccountName,
  getConfig,
  getResetInfo,
  setResetInfo,
} from '@/lib/storage';
import { parseResetHeader } from '@/lib/reset-parser';
```

- [ ] **Step 3: Register the header listener inside `defineBackground(() => { ... })`**

Add at the end of the `defineBackground` callback (after the `onMessage` listener registration):
```ts
  // Passively capture claude.ai's 5-hour usage-reset time from rate-limit
  // response headers (Gaugr-style). claude.ai polls its own usage endpoints,
  // so this populates within seconds of the tab being open.
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const headers = details.responseHeaders ?? [];
      let raw: string | undefined;
      for (const h of headers) {
        if (h.name.toLowerCase() === 'anthropic-ratelimit-unified-5h-reset') {
          raw = h.value;
          break;
        }
      }
      const resetAtMs = parseResetHeader(raw);
      if (resetAtMs != null) {
        void setResetInfo({ resetAtMs, capturedAtMs: Date.now() });
      }
      return undefined;
    },
    { urls: ['https://claude.ai/api/*'] },
    ['responseHeaders'],
  );
```

- [ ] **Step 4: Add the `GET_RESET_TIME` message case**

In the `switch (message.type)` block inside `handleAsync`, add a case before `default`:
```ts
            case 'GET_RESET_TIME':
              return await handleGetResetTime();
```

- [ ] **Step 5: Add the handler function (alongside the other `handle*` functions)**

```ts
async function handleGetResetTime() {
  const info = await getResetInfo();
  if (info) {
    return { ok: true, resetAtMs: info.resetAtMs, capturedAtMs: info.capturedAtMs };
  }
  return { ok: false, error: 'No reset time captured yet' };
}
```

- [ ] **Step 6: Verify build (catches manifest + TS issues)**

Run: `pnpm --filter @claude-queue/extension build`
Expected: build succeeds; `webRequest` appears in the generated `.output/*/manifest.json` permissions.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/wxt.config.ts apps/extension/entrypoints/background.ts
git commit -m "feat(extension): capture claude.ai 5h usage-reset from rate-limit headers"
```

---

## Task 4: Reliable mic-anchored button placement (content.ts rewrite)

**Files:**
- Rewrite: `apps/extension/entrypoints/content.ts`

- [ ] **Step 1: Replace the file with the mic-anchored, self-healing version**

Write `apps/extension/entrypoints/content.ts`:
```ts
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
      if (mic && mic.parentElement) {
        mic.parentElement.insertBefore(wrapper, mic.nextSibling);
        return;
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

/** Find claude.ai's microphone / dictation button (always present in the toolbar). */
function findMicButton(): HTMLElement | null {
  const SELECTORS = [
    'button[aria-label*="dictation" i]',
    'button[aria-label*="microphone" i]',
    'button[aria-label*="voice" i]',
    'button[aria-label*="speech" i]',
  ];
  for (const sel of SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  // Fallback: scan toolbar buttons for a mic-like aria-label.
  for (const btn of document.querySelectorAll<HTMLElement>('button[aria-label]')) {
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    if (/mic|dicta|voice|speech/.test(label)) return btn;
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
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `pnpm --filter @claude-queue/extension build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/content.ts
git commit -m "fix(extension): anchor Queue button after mic button with self-healing re-mount"
```

---

## Task 5: Redesigned ScheduleModal with two scheduling modes

**Files:**
- Rewrite: `apps/extension/components/ScheduleModal.tsx`

- [ ] **Step 1: Replace the file**

Write `apps/extension/components/ScheduleModal.tsx`:
```tsx
import React, { useState, useCallback, useEffect } from 'react';
import { computeSendTime } from '@/lib/reset-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: ScheduleConfig) => void;
}

export interface ScheduleConfig {
  promptText: string;
  modelTarget: string;
  thinkingMode: boolean;
  scheduledAt?: string; // ISO 8601 absolute send time
}

type Mode = 'session' | 'absolute';

const OFFSET_OPTIONS = [
  { label: 'None', ms: 0 },
  { label: '1 min', ms: 60_000 },
  { label: '2 min', ms: 120_000 },
  { label: '5 min', ms: 300_000 },
] as const;

const MODEL_SUGGESTIONS = [
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-3-5-haiku-20241022',
];

const DEFAULT_OFFSET_MS = 120_000; // 2 min
const DEFAULT_JITTER_S = 90;       // 0–90s

// ── Theme ──────────────────────────────────────────────────────────────────────

const CL = {
  orange: '#da7756',
  bg: '#1f1e1c',
  surface: '#2a2a27',
  surfaceHi: '#34332f',
  border: '#3d3d38',
  text: '#e8e4dd',
  muted: '#9b9790',
  green: '#5fb37e',
} as const;

// ── Component ────────────────────────────────────────────────────────────────

export const ScheduleModal: React.FC<ScheduleModalProps> = ({ isOpen, onClose, onSubmit }) => {
  const [mode, setMode] = useState<Mode>('session');
  const [offsetMs, setOffsetMs] = useState<number>(DEFAULT_OFFSET_MS);
  const [jitterSeconds, setJitterSeconds] = useState<number>(DEFAULT_JITTER_S);
  const [scheduledAt, setScheduledAt] = useState('');
  const [modelTarget, setModelTarget] = useState(MODEL_SUGGESTIONS[0]);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset-time detection (from background, populated by webRequest capture).
  const [resetAtMs, setResetAtMs] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMode('session');
    setOffsetMs(DEFAULT_OFFSET_MS);
    setJitterSeconds(DEFAULT_JITTER_S);
    setScheduledAt('');
    setIsSubmitting(false);

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await browser.runtime.sendMessage({ type: 'GET_RESET_TIME' });
        if (!cancelled && res?.ok && typeof res.resetAtMs === 'number') {
          setResetAtMs(res.resetAtMs);
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isOpen]);

  const extractPromptText = useCallback((): string => {
    const editable = document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) return editable.textContent?.trim() ?? '';
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder]');
    if (textarea) return textarea.value.trim();
    return '';
  }, []);

  // Mid-point preview time (jitter rolled at submit; preview uses the average).
  const previewMs =
    mode === 'session' && resetAtMs != null
      ? computeSendTime(resetAtMs, offsetMs, jitterSeconds * 1000, Date.now(), () => 0.5)
      : null;

  const handleSubmit = useCallback(async () => {
    const promptText = extractPromptText();
    if (!promptText) {
      alert('Please type a prompt in the Claude chat input first.');
      return;
    }

    const config: ScheduleConfig = { promptText, modelTarget, thinkingMode };

    if (mode === 'absolute') {
      if (!scheduledAt) {
        alert('Please pick a date and time.');
        return;
      }
      config.scheduledAt = new Date(scheduledAt).toISOString();
    } else {
      if (resetAtMs == null) return; // button is disabled in this state
      const sendMs = computeSendTime(resetAtMs, offsetMs, jitterSeconds * 1000);
      config.scheduledAt = new Date(sendMs).toISOString();
    }

    setIsSubmitting(true);
    await onSubmit(config);
    setIsSubmitting(false);
  }, [extractPromptText, modelTarget, thinkingMode, mode, scheduledAt, resetAtMs, offsetMs, jitterSeconds, onSubmit]);

  if (!isOpen) return null;

  const sessionDisabled = mode === 'session' && resetAtMs == null;

  // ── Style helpers ────────────────────────────────────────────────────────
  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    color: active ? '#fff' : CL.muted,
    background: active ? CL.orange : 'transparent',
    transition: 'background 0.15s, color 0.15s',
  });
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '7px 6px',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
    border: `1px solid ${active ? CL.orange : CL.border}`,
    color: active ? '#fff' : CL.muted,
    background: active ? CL.orange : CL.surface,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  });
  const input: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
    color: CL.text, background: CL.surface, border: `1px solid ${CL.border}`,
    outline: 'none', boxSizing: 'border-box',
  };
  const label: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
    textTransform: 'uppercase', color: CL.muted, marginBottom: 8,
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 999999, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: CL.bg, border: `1px solid ${CL.border}`, borderRadius: 14,
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)', width: 380,
        maxHeight: '85vh', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${CL.border}`,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: CL.text, margin: 0 }}>Queue Message</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: CL.muted, fontSize: 22,
            cursor: 'pointer', lineHeight: 1, padding: 0,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Mode segmented control */}
          <div style={{
            display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: CL.surface,
          }}>
            <button onClick={() => setMode('session')} style={segBtn(mode === 'session')}>End of session</button>
            <button onClick={() => setMode('absolute')} style={segBtn(mode === 'absolute')}>Specific time</button>
          </div>

          {mode === 'session' && (
            <>
              {/* Detected reset time */}
              <div>
                <span style={label}>Detected reset</span>
                <div style={{ ...input, display: 'flex', alignItems: 'center', cursor: 'default' }}>
                  {resetAtMs == null
                    ? <span style={{ color: CL.muted }}>Waiting for claude.ai usage data…</span>
                    : <span style={{ color: CL.text }}>{new Date(resetAtMs).toLocaleString()}</span>}
                </div>
              </div>

              {/* Offset */}
              <div>
                <span style={label}>Offset after reset</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {OFFSET_OPTIONS.map((o) => (
                    <button key={o.label} onClick={() => setOffsetMs(o.ms)} style={chip(offsetMs === o.ms)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Jitter */}
              <div>
                <span style={label}>Random jitter (max seconds)</span>
                <input
                  type="number" min={0} max={600} value={jitterSeconds}
                  onChange={(e) => setJitterSeconds(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  style={input}
                />
              </div>

              {/* Preview */}
              {previewMs != null && (
                <div style={{ fontSize: 13, color: CL.green }}>
                  Will send around {new Date(previewMs).toLocaleTimeString()} (±{jitterSeconds}s)
                </div>
              )}
            </>
          )}

          {mode === 'absolute' && (
            <div>
              <span style={label}>Send at</span>
              <input
                type="datetime-local" value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)} style={input}
              />
            </div>
          )}

          {/* Model */}
          <div>
            <span style={label}>Model</span>
            <select value={modelTarget} onChange={(e) => setModelTarget(e.target.value)} style={input}>
              {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {/* Thinking toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: CL.text }}>Extended Thinking</span>
            <button onClick={() => setThinkingMode(!thinkingMode)} style={{
              position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none',
              cursor: 'pointer', background: thinkingMode ? CL.orange : CL.surfaceHi,
              transition: 'background 0.15s', padding: 0,
            }}>
              <span style={{
                position: 'absolute', top: 2, left: thinkingMode ? 22 : 2, width: 20, height: 20,
                borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                transition: 'left 0.15s',
              }} />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 20px', borderTop: `1px solid ${CL.border}` }}>
          <button onClick={handleSubmit} disabled={isSubmitting || sessionDisabled} style={{
            width: '100%', padding: '11px 16px', borderRadius: 10, border: 'none',
            fontSize: 14, fontWeight: 600, color: '#fff', background: CL.orange,
            cursor: (isSubmitting || sessionDisabled) ? 'not-allowed' : 'pointer',
            opacity: (isSubmitting || sessionDisabled) ? 0.5 : 1, transition: 'opacity 0.15s',
          }}>
            {isSubmitting ? 'Queueing…' : sessionDisabled ? 'Waiting for reset time…' : 'Queue Message'}
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `pnpm --filter @claude-queue/extension build`
Expected: build succeeds. (Note: `ScheduleConfig` no longer has `delaySeconds`; Task 6 updates the consumer.)

- [ ] **Step 3: Commit**

```bash
git add apps/extension/components/ScheduleModal.tsx
git commit -m "feat(extension): redesign Queue modal with end-of-session + specific-time modes"
```

---

## Task 6: Update background job consumer for the simplified config

**Files:**
- Modify: `apps/extension/entrypoints/background.ts:108-145` (the `handleQueueJob` function)

- [ ] **Step 1: Simplify `handleQueueJob` to use only `scheduledAt`**

Replace the payload-building block in `handleQueueJob` so it no longer references `config.delaySeconds`:
```ts
  const payload: CreateJobPayload = {
    accountId,
    promptText: config.promptText,
    modelTarget: config.modelTarget,
    thinkingMode: config.thinkingMode,
    attachments: [],
  };

  if (config.scheduledAt) {
    payload.scheduledFor = config.scheduledAt;
  }
```
(Remove the `else if (config.delaySeconds)` branch — the modal always produces `scheduledAt` now.)

- [ ] **Step 2: Build to confirm no references to removed fields remain**

Run: `pnpm --filter @claude-queue/extension build`
Expected: build succeeds with no TS errors about `delaySeconds`.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "refactor(extension): queue jobs always use absolute scheduledFor"
```

---

## Task 7: Align QueueButton sizing to claude.ai toolbar icons

**Files:**
- Modify: `apps/extension/components/QueueButton.tsx:31-48` (the `btnStyle` object)

- [ ] **Step 1: Tighten the button to match adjacent toolbar icon buttons**

In `QueueButton.tsx`, update `btnStyle` dimensions/spacing so it visually matches the mic/wave buttons (which are ~32px, borderless, subtle):
```ts
  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: '#da7756',
    cursor: 'pointer',
    marginLeft: 2,
    marginRight: 2,
    flexShrink: 0,
    padding: 0,
    transition: 'background 0.15s, color 0.15s',
    outline: 'none',
  };
```
And update the hover handlers to match the borderless style:
```tsx
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(218, 119, 86, 0.15)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @claude-queue/extension build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/components/QueueButton.tsx
git commit -m "style(extension): match Queue button sizing to toolbar icons"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the unit tests**

Run: `pnpm --filter @claude-queue/extension test`
Expected: all `reset-parser` tests PASS.

- [ ] **Step 2: Production build for both targets**

Run:
```bash
pnpm --filter @claude-queue/extension build
pnpm --filter @claude-queue/extension exec wxt build -b firefox
```
Expected: both builds succeed; `.output/chrome-mv3/manifest.json` and `.output/firefox-mv2/manifest.json` both list `webRequest` in permissions.

- [ ] **Step 3: Manual verification on claude.ai** (load the unpacked build)

Confirm each:
- Queue button appears **between the mic button and the wave button** within ~1–2 s of the page settling.
- Typing swaps the wave button for the orange send button and the Queue button **stays put** (does not disappear or jump).
- Opening the modal shows a **Detected reset** time (wait a few seconds after page load for header capture); "End of session" preview line shows a plausible "Will send around …" time.
- Switching to **Specific time** shows the datetime picker and queues correctly.
- A queued "end of session" message lands in the backend with `scheduledFor ≈ reset + offset + jitter`.

- [ ] **Step 4: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "chore(extension): verification fixes for queue UI redesign"
```

---

## Notes for the implementer

- `storage`, `browser`, `defineBackground`, `defineContentScript`, `createIntegratedUi` are WXT auto-imports — do not add explicit imports for them.
- Do not add any CSS import to `content.ts` — injecting into claude.ai's `<head>` blanks the page. Inline styles only.
- claude.ai's exact mic-button `aria-label` may differ; the `findMicButton` scan fallback covers label drift. If manual testing shows a different label, add it to the `SELECTORS` list.
- The `anthropic-ratelimit-unified-5h-reset` header name is matched case-insensitively; if claude.ai renames it, update the comparison in `background.ts` only.
