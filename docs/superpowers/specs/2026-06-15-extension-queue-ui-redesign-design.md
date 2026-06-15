# Extension Queue UI Redesign & Session-Reset Scheduling

**Date:** 2026-06-15
**Status:** Approved (design); pending spec review
**Scope:** `apps/extension` only — no API or worker changes.

## Problem

The browser extension's Queue button is in the wrong place, is slow to appear,
and sometimes detaches. The Queue modal UI is dated, and its scheduling model
(fixed Delay / Send-At) doesn't support the real use case: firing a message
right when the claude.ai usage window resets.

Three concrete defects:

1. **Placement.** The button renders inside the text area or floating loosely,
   not in the toolbar. It should sit between the microphone button and the
   waveform button. The waveform button is swapped for the orange send button
   the moment the user types — anchoring relative to that button is the root
   cause of the button detaching.
2. **Reliability.** A one-shot mount means React re-renders (notably the
   wave↔send swap) tear the button out, and it "takes a while" to appear.
3. **Scheduling + UI.** The modal is visually rough and offers only relative
   delays / absolute time. We need a "send at end of current session" mode keyed
   to the usage-limit reset, with a configurable offset plus random jitter.

## Goals

- Queue button reliably sits **between the mic button and the wave/send button**
  and survives React re-renders.
- Redesigned, cleaner modal matching claude.ai's dark theme.
- Two scheduling modes:
  - **Specific time** — absolute datetime.
  - **End of session** — `resetTime + offset + randomJitter`, computed in the
    extension into a single absolute `scheduledFor`.
- **Reset time is always detected** from claude.ai's own rate-limit headers
  (Gaugr-style). No guessing, no fixed-window fallback.

## Non-Goals

- No backend (API/worker) changes — the extension always sends an absolute
  `scheduledFor` ISO timestamp, which the backend already supports.
- No tracking of the 7-day weekly window (only the 5-hour session window).
- No popup (`entrypoints/popup`) changes beyond what's incidental.

## Architecture

### 1. Button placement & persistence (`entrypoints/content.ts`)

Anchor on the **microphone button**, which is always present and never swapped,
and insert our button immediately **after** it — placing it between the mic and
the wave/send button.

- Selector strategy for the mic button (try in order, fall back to scanning):
  - `button[aria-label*="dictation" i]`, `button[aria-label*="microphone" i]`,
    `button[aria-label*="voice" i]`, `button[aria-label*="speech" i]`.
  - Fallback: scan toolbar buttons for one whose `aria-label` matches
    `/mic|dicta|voice|speech/i`.
- Replace the one-shot `createIntegratedUi` mount with a **persistent
  re-anchoring loop**: a `MutationObserver` on the input toolbar subtree that,
  whenever our `#claude-queue-root` wrapper is missing from the DOM, re-inserts
  it after the current mic button. Debounce re-checks to avoid thrash on the
  wave↔send swap.
- The React root is created once; on re-anchor we move the existing wrapper
  node rather than re-rendering, so component state (open modal, status) is
  preserved.
- Keep the no-CSS-injection rule: inline styles only.

### 2. Reset-time detection (`entrypoints/background.ts` + storage)

Gaugr-style passive interception of claude.ai's existing API traffic.

- Add `webRequest` to manifest `permissions` (host permission for
  `https://claude.ai/*` already present).
- Register `browser.webRequest.onHeadersReceived` for
  `{ urls: ['https://claude.ai/api/*'] }` with
  `extraInfoSpec: ['responseHeaders']` (Chrome MV3 also needs `'extraHeaders'`
  where required; Firefox MV2 supports `responseHeaders` directly).
- From each response, read `anthropic-ratelimit-unified-5h-reset`
  (case-insensitive). Also capture any `anthropic-ratelimit-unified-*-reset`
  for forward-compat, but only the **5h** value is used as "end of session".
- Parse the value robustly: if it's all digits treat as epoch **seconds**
  (×1000 if it looks like seconds, leave if ms), otherwise `Date.parse` as
  RFC-3339. Reject non-finite / past-by-more-than-a-window values.
- Persist `{ resetAtMs, capturedAtMs }` to extension storage
  (`storage.ts` gets `getResetInfo` / `setResetInfo`).
- New message handler `GET_RESET_TIME` returns the latest persisted reset info
  (or `{ ok: false }` if none captured yet — the modal then shows a "waiting for
  claude.ai…" state and polls).

### 3. Modal redesign + scheduling (`components/ScheduleModal.tsx`)

`ScheduleConfig` is unchanged at the wire level — it still resolves to
`scheduledAt` (absolute ISO) or, only for the legacy path, `delaySeconds`. End-
of-session mode always produces `scheduledAt`.

Mode toggle (segmented control):

- **Specific time** — `datetime-local` input → `scheduledAt = new Date(value).toISOString()`.
- **End of session** — fields:
  - Detected reset time (read-only display, refreshed from `GET_RESET_TIME`).
  - **Offset** — presets `0 / 1 / 2 / 5 min` + custom; default **2 min**.
  - **Jitter (max)** — default **90 s**, configurable; final jitter is
    `Math.random() * maxJitterMs`, re-rolled at submit.
  - Live preview line: "Will send at ≈ \<localized time\>".
  - On submit: `scheduledAt = new Date(resetAtMs + offsetMs + jitterMs).toISOString()`.

UI polish: smaller modal width, segmented mode toggle, consistent 8px spacing
scale, remove the emoji from the primary button, keep Model dropdown and
Extended Thinking toggle. Inline styles only (shadow-DOM safe).

## Data Flow

```
claude.ai API response
  → webRequest.onHeadersReceived (background)
  → parse anthropic-ratelimit-unified-5h-reset
  → storage.setResetInfo({ resetAtMs, capturedAtMs })

QueueButton click → ScheduleModal opens
  → GET_RESET_TIME (modal → background → storage) → display reset time
  → user picks offset + jitter
  → submit: scheduledAt = resetAtMs + offset + random(jitter)
  → QUEUE_JOB (config) → background.handleQueueJob
  → createJob({ ..., scheduledFor: scheduledAt })   // unchanged
```

## Error Handling

- **No reset captured yet:** modal "End of session" mode shows a non-blocking
  "Waiting for claude.ai usage data…" message and polls `GET_RESET_TIME` every
  ~2 s; the Queue button is disabled in that mode until a reset time is known.
  "Specific time" mode remains usable meanwhile.
- **Stale reset (already passed):** if `resetAtMs` is in the past at submit
  time, treat the window as already reset → schedule at `now + offset + jitter`.
- **Header parse failure:** ignored (not persisted); detection simply waits for
  the next intercepted response.
- **Mic button not found:** fall back to the previous anchor chain (send button
  → contenteditable) so the button still appears, just less ideally placed.

## Testing

- Unit-test the reset-header parser (epoch-seconds, epoch-ms, RFC-3339, garbage,
  past timestamps) — pure function, no DOM.
- Unit-test the send-time computation (`resetAtMs + offset + jitter`, jitter
  within `[0, max]`, stale-reset → now-based).
- Manual verification on claude.ai: button position between mic and wave/send;
  survives typing (wave→send swap) and conversation switches; reset time
  appears; "will send at" preview matches; queued job lands in backend with the
  expected `scheduledFor`.

## Files

- `apps/extension/wxt.config.ts` — add `webRequest` permission.
- `apps/extension/entrypoints/content.ts` — mic-anchored placement + persistent re-anchor observer.
- `apps/extension/entrypoints/background.ts` — `onHeadersReceived` capture + `GET_RESET_TIME` handler.
- `apps/extension/lib/storage.ts` — `getResetInfo` / `setResetInfo`.
- `apps/extension/lib/reset-parser.ts` (new) — pure header-parse + send-time helpers (testable).
- `apps/extension/components/ScheduleModal.tsx` — redesigned UI + two modes.
- `apps/extension/components/QueueButton.tsx` — minor styling alignment to toolbar icons.
</content>
</invoke>
