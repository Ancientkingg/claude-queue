# Queued Message Visibility — In-Chat Bubbles, Sidebar & Pseudo-Chat

**Date:** 2026-06-15
**Status:** Approved (design); pending spec review
**Scope:** `apps/extension` (rendering + data layer) and `apps/api` (cancel endpoint + list filters). No worker changes.

## Problem

Once a message is queued, it disappears from view — the user can't see what's
pending, when it will send, or cancel it. We want queued messages to be visible
and manageable directly inside claude.ai:

1. In the conversation they were queued into, queued messages should appear in
   the thread *as if sent*, but marked specially with a small menu showing the
   approximate send time and a Cancel action.
2. A new **"Queued"** section in claude.ai's left sidebar lists every chat that
   has a queued message. Entries for existing conversations link to that chat;
   entries for messages queued into a *new* chat open a pseudo-chat view.
3. The pseudo-chat is a faux chat window (no input box) that shows the queued
   message and its menu — it is not a real claude.ai conversation.

## Goals

- See queued (PENDING) messages inline in their target conversation, styled like
  sent user messages, each with a footer menu: "Sends ≈ {time}" + Cancel.
- Cancel a queued message (removes it everywhere).
- A "Queued" sidebar section: one entry per existing chat (count badge if
  several queued), one entry per new-chat queue.
- Clicking an existing-chat entry navigates to `/chat/{id}`; clicking a new-chat
  entry opens an injected pseudo-chat overlay.
- Backend remains the source of truth; the view survives page reloads.

## Non-Goals

- No worker changes — it already navigates to `/chat/{conversationId}` (or
  `/new` when null), so conversation targeting already works.
- No editing of a queued message (cancel + re-queue instead).
- No display of non-PENDING jobs (PROCESSING/COMPLETED/FAILED) — once a job
  leaves PENDING the real message exists on claude.ai and the placeholder is
  dropped.
- No real routing for pseudo-chats (overlay only; claude.ai's router untouched).

## Backend changes (`apps/api`)

### 1. List filters — `GET /jobs`

Add optional query params `accountId` (uuid) and `status` (MessageStatus). When
present, filter the query. Keeps existing pagination. This lets the extension
fetch only this account's PENDING jobs.

- `queue.service.findAll(page, limit, filters?)` adds a `where` clause.
- `queue.controller.listJobs` reads + validates the new params.

### 2. Cancel — `DELETE /jobs/:id`

- `queue.service.cancelJob(id)`:
  - Load the job; if not found → `NotFoundException`.
  - If `status !== PENDING` → `ConflictException` ("Job is no longer
    cancelable").
  - Remove the delayed BullMQ job (by the stored BullMQ job id; see
    implementation note below).
  - Delete the DB row (cancel = remove entirely).
- `queue.controller`: `@Delete(':id')` returns `{ ok: true }` (204/200).

**BullMQ removal note:** `createJob` currently adds a delayed job to the queue.
The plan must ensure the BullMQ job id is recoverable for removal — either it is
already set to the DB job id (preferred: pass `{ jobId: dbJob.id }` when adding),
or `cancelJob` looks the delayed job up. The implementation task verifies the
current add call and wires removal accordingly.

## Extension data layer

### `lib/queue-store.ts` (new)

A small observable store of *this account's* PENDING jobs, used by all three
rendering surfaces.

```ts
export interface QueuedJob {
  id: string;
  conversationId: string | null;
  promptText: string;
  modelTarget: string;
  scheduledFor: string;   // ISO
  status: string;         // expected PENDING
}

// Subscribe for changes; returns an unsubscribe fn.
subscribe(listener: (jobs: QueuedJob[]) => void): () => void;
getJobs(): QueuedJob[];
refresh(): Promise<void>;            // LIST_QUEUED_JOBS via background
addOptimistic(job: QueuedJob): void; // insert immediately on queue
remove(id: string): void;            // local removal after cancel
startPolling(intervalMs: number): () => void; // ~10s; returns stop fn
```

- `refresh()` sends `{ type: 'LIST_QUEUED_JOBS' }` to the background, which calls
  `listJobs` with `accountId` (from storage) + `status=PENDING`, and returns the
  mapped jobs. The store replaces its contents and notifies listeners.
- Polling: `startPolling` refreshes every `intervalMs`; the orchestrator also
  calls `refresh()` on SPA navigation (URL change) and after a successful queue.
- Optimistic: `QueueButton`'s submit handler calls `addOptimistic` so the bubble
  appears instantly; the next `refresh` reconciles (replacing the temp id with
  the real one — temp jobs use an `id` prefixed `optimistic-` and are matched by
  promptText+conversationId until the real job arrives).

### Background handlers (`entrypoints/background.ts`)

- `LIST_QUEUED_JOBS` → `listJobs` with `{ accountId, status: 'PENDING' }`; map to
  `QueuedJob[]`; return `{ ok, jobs }`.
- `CANCEL_JOB` (payload `{ id }`) → `DELETE /jobs/:id` via a new api-client
  `cancelJob(id)`; return `{ ok }`.
- `api-client.ts`: add `cancelJob(id)` (DELETE) and extend `listJobs` to accept
  `{ accountId?, status?, limit? }` query params.

### Modal change (`components/ScheduleModal.tsx` + `QueueButton.tsx`)

- Add `conversationId` to `ScheduleConfig`, derived at submit time:
  `const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i); conversationId = m?.[1] ?? null;`
- `background.handleQueueJob` already forwards `conversationId` to
  `CreateJobPayload` — wire `config.conversationId` into it.
- After a successful queue, `QueueButton` calls `queueStore.addOptimistic(...)`.

## Extension rendering (three modules)

All use the established pattern: a single React root per surface mounted into an
inline-styled wrapper, re-anchored by a `MutationObserver` when claude.ai
re-renders. Inline styles only (no CSS injection).

### 1. In-chat queued bubbles — `components/QueuedBubbles.tsx` + mount in `content.ts`

- Anchor: the message-thread scroll container (find the last message element;
  insert our wrapper after the messages list). The orchestrator re-derives the
  current `conversationId` from the URL.
- Render: for each store job whose `conversationId` === current conversation, a
  bubble styled like a sent user message (right-aligned, claude bubble bg from
  the theme constants), followed by a footer row:
  - Left: clock icon + "Sends ≈ {localized time}" (relative + absolute).
  - Right: **Cancel** button → `CANCEL_JOB` → `queueStore.remove(id)`.
- When the current conversation has no queued jobs, the wrapper renders nothing.

### 2. "Queued" sidebar section — `components/QueuedSidebar.tsx` + mount in `content.ts`

- Anchor: claude.ai's sidebar nav container (locate the existing chat-history
  list; insert a "Queued" section above it). Fallback selectors + observer.
- Build entries from the store:
  - Group jobs with a non-null `conversationId` by conversation → one entry per
    chat, with a count badge when >1. Label: reuse claude's own sidebar title by
    matching an `a[href$="/chat/{id}"]` in the existing nav; fall back to a
    prompt-text preview. Click → navigate to `/chat/{id}` (anchor href).
  - Each job with `conversationId === null` → its own entry. Label: clock icon +
    prompt preview. Click → open pseudo-chat overlay for that job id.
- Header shows the total count. Hidden entirely when there are no PENDING jobs.

### 3. Pseudo-chat overlay — `components/PseudoChat.tsx` + mount in `content.ts`

- A fixed overlay panel over the main content area (not full-screen modal; sized
  like the chat column), shown when a new-chat sidebar entry is clicked
  (orchestrator holds `openPseudoChatId` state, passed via a small event/store).
- Renders a faux thread: the queued message bubble (same component as in-chat)
  with its footer menu (send time + Cancel), a header ("Queued · new chat"),
  and a close (×). **No input box.**
- Canceling the only job closes the overlay (job gone). Closing returns to
  claude.ai unchanged.

### Orchestration — `content.ts`

`content.ts` becomes the orchestrator that:
- Mounts the Queue button (existing behavior, unchanged placement logic).
- Creates the shared `queueStore`, starts polling, and refreshes on URL change
  (poll `location.href` or hook history pushState/popstate).
- Mounts the three rendering surfaces, each subscribing to the store.
- Holds `openPseudoChatId` and routes new-chat sidebar clicks to the overlay.

## Data Flow

```
Queue (modal) → conversationId from URL → background POST /jobs
   ↳ QueueButton.addOptimistic(job) → store notifies → bubble + sidebar entry appear
Poll LIST_QUEUED_JOBS (10s / on-nav / post-queue) → store reconciles (PENDING only)
Worker sends a job → status leaves PENDING → next refresh drops the placeholder
Cancel → CANCEL_JOB → DELETE /jobs/:id → store.remove(id) → bubble + entry vanish
```

## Error Handling

- **Cancel race** (job already sending): `DELETE` returns 409 → toast/inline
  "Already sending — can't cancel", and `refresh()` so the UI reflects reality.
- **No accountId paired:** store stays empty; nothing renders (same as today's
  queue gate).
- **Backend unreachable on poll:** keep last-known jobs, retry next interval; log
  once.
- **Anchor not found** (claude.ai markup drift): each surface no-ops gracefully;
  the Queue button (already verified) is unaffected.
- **Optimistic mismatch:** if a queued POST fails, the optimistic job is removed
  and an inline error shown (reuse `QueueButton` status text).

## Testing

- **Pure/unit (vitest):**
  - `queue-store`: add/remove/reconcile logic, optimistic→real matching,
    filtering by conversationId, subscribe notifications (store is DOM-free if
    the message-send is injected).
  - conversationId extraction from a set of URLs (`/chat/<uuid>`, `/new`, `/`,
    project URLs) — pure helper `parseConversationId(pathname)`.
- **Backend:** manual/integration — `GET /jobs?accountId&status=PENDING` filters;
  `DELETE /jobs/:id` removes BullMQ job + row; 409 when not PENDING; 404 when
  missing.
- **Manual on claude.ai (Firefox MV2 temp add-on):** queue into current chat →
  bubble appears with correct ≈time and Cancel works; "Queued" sidebar shows the
  chat (and grouping/badge); queue into a new chat → sidebar entry → pseudo-chat
  overlay renders the bubble with no input box; reload page → queued items
  persist; let one fire (or simulate) → placeholder disappears.

## Files

**API:**
- `apps/api/src/queue/queue.controller.ts` — `@Delete(':id')`; `accountId`/`status` query params on `listJobs`.
- `apps/api/src/queue/queue.service.ts` — `cancelJob(id)`; `findAll` filters; ensure BullMQ job id is recoverable.

**Extension — data:**
- `apps/extension/lib/queue-store.ts` (new) + `apps/extension/lib/queue-store.test.ts` (new)
- `apps/extension/lib/conversation.ts` (new, `parseConversationId`) + test
- `apps/extension/lib/api-client.ts` — `cancelJob`; `listJobs` filters
- `apps/extension/entrypoints/background.ts` — `LIST_QUEUED_JOBS`, `CANCEL_JOB`
- `apps/extension/components/ScheduleModal.tsx` / `QueueButton.tsx` — capture conversationId, optimistic insert

**Extension — rendering:**
- `apps/extension/components/QueuedBubbles.tsx` (new)
- `apps/extension/components/QueuedSidebar.tsx` (new)
- `apps/extension/components/PseudoChat.tsx` (new)
- `apps/extension/entrypoints/content.ts` — orchestrator (store, polling, nav, mounts)

## Build Phases (one spec, incremental plan)

1. **Phase 1 — Core:** backend cancel + list filters; conversationId capture;
   `queue-store`; in-chat bubbles with cancel + optimistic insert. Independently
   useful (see & cancel in the open chat).
2. **Phase 2 — Sidebar:** "Queued" section with grouping/badges + navigation.
3. **Phase 3 — Pseudo-chat:** overlay for new-chat entries.
</content>
