# Queued Message Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make queued (PENDING) messages visible and cancelable inside claude.ai — as in-chat bubbles in their target conversation, a "Queued" sidebar section, and a pseudo-chat overlay for messages queued into new chats.

**Architecture:** The API gains a cancel endpoint and list filters. The extension keeps the backend as the source of truth via an observable `QueueStore` (polled + optimistic). Three React surfaces are injected into claude.ai's DOM (inline styles, `MutationObserver` re-mount), all driven by the store. Built in three phases: core in-chat + cancel, then sidebar, then pseudo-chat.

**Tech Stack:** NestJS + Prisma + BullMQ (API); WXT + React 18 + TypeScript + Vitest (extension).

---

## File Structure

**API (`apps/api/src/queue`):**
- `queue.service.ts` (modify) — `findAll` filters; `cancelJob(id)`.
- `queue.controller.ts` (modify) — `accountId`/`status` query params; `@Delete(':id')`.

**Extension data/pure layer:**
- `lib/conversation.ts` (new) — `parseConversationId(pathname)`. + test.
- `lib/queue-store.ts` (new) — observable store of PENDING jobs. + test.
- `lib/api-client.ts` (modify) — `listQueuedJobs`, `cancelJob`.
- `entrypoints/background.ts` (modify) — `LIST_QUEUED_JOBS`, `CANCEL_JOB`.
- `lib/theme.ts` (new) — shared color constants (extracted from ScheduleModal).

**Extension UI:**
- `components/ScheduleModal.tsx` / `components/QueueButton.tsx` (modify) — capture conversationId, optimistic insert.
- `components/queue-hooks.tsx` (new) — `useQueueJobs`, `useLocationPath`, `formatSendTime`.
- `components/QueuedBubbles.tsx` (new) — in-chat bubbles.
- `components/QueuedSidebar.tsx` (new) — sidebar section.
- `components/PseudoChat.tsx` (new) — new-chat overlay.
- `entrypoints/content.ts` (modify) — orchestrator: store, polling, nav events, mounts.

---

# PHASE 1 — Core: backend cancel/filters, store, in-chat bubbles

## Task 1: API — list filters + cancel endpoint

**Files:**
- Modify: `apps/api/src/queue/queue.service.ts`
- Modify: `apps/api/src/queue/queue.controller.ts`

> No test framework exists in `apps/api`; verify with the dev server + curl.

- [ ] **Step 1: Add filters to `findAll`**

Replace the `findAll` method in `queue.service.ts`:
```ts
  async findAll(
    page = 1,
    limit = 20,
    filters: { accountId?: string; status?: string } = {},
  ) {
    const skip = (page - 1) * limit;

    const where: { account_id?: string; status?: string } = {};
    if (filters.accountId) where.account_id = filters.accountId;
    if (filters.status) where.status = filters.status;

    const [items, total] = await Promise.all([
      this.prisma.queuedMessage.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          attachments: true,
          account: { select: { id: true, account_name: true, status: true } },
        },
      }),
      this.prisma.queuedMessage.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
```

- [ ] **Step 2: Add `cancelJob` to the service**

Add `ConflictException` to the imports on line 1:
```ts
import { Injectable, Logger, NotFoundException, ConflictException, Inject } from '@nestjs/common';
```
Add this method after `findById`:
```ts
  async cancelJob(id: string) {
    const job = await this.prisma.queuedMessage.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job with id "${id}" not found`);
    }
    if (job.status !== 'PENDING') {
      throw new ConflictException('Job is no longer cancelable');
    }

    // Remove the delayed BullMQ job (added with jobId = message.id).
    try {
      const bull = await this.queue.getJob(id);
      if (bull) await bull.remove();
    } catch (err) {
      this.logger.warn(`BullMQ remove failed for ${id}: ${String(err)}`);
    }

    await this.prisma.queuedMessage.delete({ where: { id } });
    this.logger.log(`Job ${id} canceled and removed`);
    return { ok: true };
  }
```

- [ ] **Step 3: Wire query filters + delete route in the controller**

In `queue.controller.ts`, extend the imports:
```ts
import {
  Controller, Post, Get, Param, Body, Query, Delete,
  BadRequestException, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
```
Replace the `listJobs` signature/body's `findAll` call to pass filters:
```ts
  @Get()
  async listJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('accountId') accountId?: string,
    @Query('status') status?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    if (isNaN(pageNum) || pageNum < 1) {
      throw new BadRequestException('page must be a positive integer');
    }
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    const ALLOWED = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
    if (status && !ALLOWED.includes(status)) {
      throw new BadRequestException(`status must be one of ${ALLOWED.join(', ')}`);
    }

    const result = await this.queueService.findAll(pageNum, limitNum, { accountId, status });

    this.logger.log(`📋 Listed ${result.items.length}/${result.total} jobs (page ${pageNum})`);
    return {
      ...result,
      items: result.items.map((job) => ({
        id: job.id,
        accountId: job.account_id,
        conversationId: job.conversation_id,
        modelTarget: job.model_target,
        promptText: job.prompt_text,
        thinkingMode: job.thinking_mode,
        status: job.status,
        scheduledFor: job.scheduled_for.toISOString(),
        createdAt: job.created_at.toISOString(),
        account: job.account,
        attachments: job.attachments.map((a) => ({
          id: a.id, storageKey: a.storage_key, fileName: a.file_name, mimeType: a.mime_type,
        })),
      })),
    };
  }
```
Add the delete handler after `getJob`:
```ts
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancelJob(@Param('id') id: string) {
    this.logger.log(`🗑️  Canceling job ${id}`);
    return this.queueService.cancelJob(id);
  }
```

- [ ] **Step 4: Verify with the running API**

Run (with the API + Postgres + Redis up via `pnpm docker:up` or local dev):
```bash
# filter
curl -s 'http://localhost:3001/jobs?status=PENDING&limit=5' | head -c 400; echo
# cancel a known PENDING id (replace <id>)
curl -s -X DELETE 'http://localhost:3001/jobs/<id>' -w ' HTTP %{http_code}\n'
# cancel again → 409 (no longer exists / not pending) or 404
curl -s -X DELETE 'http://localhost:3001/jobs/<id>' -w ' HTTP %{http_code}\n'
```
Expected: filtered list returns only PENDING items; first delete `{ "ok": true }` HTTP 200; second returns HTTP 404.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/queue/queue.service.ts apps/api/src/queue/queue.controller.ts
git commit -m "feat(api): add DELETE /jobs/:id cancel + accountId/status list filters"
```

---

## Task 2: Extension — conversationId parser (TDD)

**Files:**
- Create: `apps/extension/lib/conversation.ts`
- Create: `apps/extension/lib/conversation.test.ts`

- [ ] **Step 1: Write the failing test `apps/extension/lib/conversation.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { parseConversationId } from './conversation';

describe('parseConversationId', () => {
  const id = '019ecc1d-18cc-78c1-8d6d-160f22e61cad';
  it('extracts the uuid from a /chat/ path', () => {
    expect(parseConversationId(`/chat/${id}`)).toBe(id);
    expect(parseConversationId(`/chat/${id}?foo=1`)).toBe(id);
  });
  it('returns null for new-chat and non-chat paths', () => {
    expect(parseConversationId('/new')).toBeNull();
    expect(parseConversationId('/')).toBeNull();
    expect(parseConversationId('/project/abc')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @claude-queue/extension test`
Expected: FAIL — cannot resolve `./conversation`.

- [ ] **Step 3: Implement `apps/extension/lib/conversation.ts`**
```ts
/**
 * Extract the claude.ai conversation id from a URL pathname.
 * Conversation URLs look like `https://claude.ai/chat/<uuid>`. Returns null for
 * new-chat (`/new`), the root, and any non-chat path.
 */
export function parseConversationId(pathname: string): string | null {
  const m = pathname.match(/\/chat\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @claude-queue/extension test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/extension/lib/conversation.ts apps/extension/lib/conversation.test.ts
git commit -m "feat(extension): add parseConversationId helper with tests"
```

---

## Task 3: Extension — QueueStore (TDD)

**Files:**
- Create: `apps/extension/lib/queue-store.ts`
- Create: `apps/extension/lib/queue-store.test.ts`

- [ ] **Step 1: Write the failing test `apps/extension/lib/queue-store.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest';
import { QueueStore, type QueuedJob } from './queue-store';

const job = (id: string, conversationId: string | null = null): QueuedJob => ({
  id, conversationId, promptText: 'p-' + id, modelTarget: 'm', scheduledFor: '2026-06-15T19:00:00Z', status: 'PENDING',
});

describe('QueueStore', () => {
  it('notifies subscribers immediately and on change', async () => {
    const store = new QueueStore(async () => [job('a')]);
    const seen: QueuedJob[][] = [];
    store.subscribe((j) => seen.push(j));
    expect(seen[0]).toEqual([]);          // initial empty
    await store.refresh();
    expect(seen[1]).toEqual([job('a')]);  // after fetch
  });

  it('replaces contents on refresh', async () => {
    let batch = [job('a')];
    const store = new QueueStore(async () => batch);
    await store.refresh();
    batch = [job('b')];
    await store.refresh();
    expect(store.getJobs()).toEqual([job('b')]);
  });

  it('retains an optimistically-added job until it appears or the grace expires', async () => {
    let now = 1000;
    const store = new QueueStore(async () => [], { graceMs: 100, now: () => now });
    store.addOptimistic(job('a'));
    await store.refresh();                       // fetch empty, within grace
    expect(store.getJobs().map(j => j.id)).toEqual(['a']);
    now = 2000;                                  // past grace
    await store.refresh();
    expect(store.getJobs()).toEqual([]);
  });

  it('dedupes when the real job arrives in a fetch', async () => {
    const store = new QueueStore(async () => [job('a')], { graceMs: 10_000, now: () => 0 });
    store.addOptimistic(job('a'));
    await store.refresh();
    expect(store.getJobs().map(j => j.id)).toEqual(['a']); // not duplicated
  });

  it('remove() drops a job and stops retaining it', async () => {
    const store = new QueueStore(async () => [], { graceMs: 10_000, now: () => 0 });
    store.addOptimistic(job('a'));
    store.remove('a');
    await store.refresh();
    expect(store.getJobs()).toEqual([]);
  });

  it('jobsForConversation filters by conversationId', () => {
    const store = new QueueStore(async () => []);
    store.addOptimistic(job('a', 'c1'));
    store.addOptimistic(job('b', null));
    expect(store.jobsForConversation('c1').map(j => j.id)).toEqual(['a']);
    expect(store.jobsForConversation(null).map(j => j.id)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @claude-queue/extension test`
Expected: FAIL — cannot resolve `./queue-store`.

- [ ] **Step 3: Implement `apps/extension/lib/queue-store.ts`**
```ts
export interface QueuedJob {
  id: string;
  conversationId: string | null;
  promptText: string;
  modelTarget: string;
  scheduledFor: string; // ISO 8601
  status: string;       // expected 'PENDING'
}

type Listener = (jobs: QueuedJob[]) => void;
type Fetcher = () => Promise<QueuedJob[]>;
interface Options { graceMs?: number; now?: () => number }

/**
 * Observable store of this account's PENDING queued jobs. The backend is the
 * source of truth (via `fetcher`); locally-added (optimistic) jobs are retained
 * for a short grace window so freshly-queued messages show instantly without
 * flickering before the next fetch reflects them.
 */
export class QueueStore {
  private jobs: QueuedJob[] = [];
  private listeners = new Set<Listener>();
  private localAdds: { job: QueuedJob; at: number }[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(private fetcher: Fetcher, opts: Options = {}) {
    this.graceMs = opts.graceMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  getJobs(): QueuedJob[] { return this.jobs; }

  jobsForConversation(conversationId: string | null): QueuedJob[] {
    return this.jobs.filter((j) => j.conversationId === conversationId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.jobs);
    return () => { this.listeners.delete(listener); };
  }

  private notify() { for (const l of this.listeners) l(this.jobs); }

  private recompute(fetched: QueuedJob[]) {
    const fetchedIds = new Set(fetched.map((j) => j.id));
    this.localAdds = this.localAdds.filter(
      (a) => !fetchedIds.has(a.job.id) && this.now() - a.at < this.graceMs,
    );
    this.jobs = [...fetched, ...this.localAdds.map((a) => a.job)];
    this.notify();
  }

  async refresh(): Promise<void> {
    try {
      const fetched = await this.fetcher();
      this.recompute(fetched);
    } catch {
      /* keep last-known jobs on transient failure */
    }
  }

  addOptimistic(job: QueuedJob): void {
    this.localAdds.push({ job, at: this.now() });
    this.jobs = [...this.jobs.filter((j) => j.id !== job.id), job];
    this.notify();
  }

  remove(id: string): void {
    this.localAdds = this.localAdds.filter((a) => a.job.id !== id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.notify();
  }

  startPolling(intervalMs: number): () => void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), intervalMs);
    return () => { if (this.pollTimer) clearInterval(this.pollTimer); };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @claude-queue/extension test`
Expected: PASS (all QueueStore cases green).

- [ ] **Step 5: Commit**
```bash
git add apps/extension/lib/queue-store.ts apps/extension/lib/queue-store.test.ts
git commit -m "feat(extension): add observable QueueStore with optimistic grace + tests"
```

---

## Task 4: Extension — api-client + background handlers

**Files:**
- Modify: `apps/extension/lib/api-client.ts`
- Modify: `apps/extension/entrypoints/background.ts`

- [ ] **Step 1: Add `listQueuedJobs` + `cancelJob` to api-client**

Append to `apps/extension/lib/api-client.ts`:
```ts
// === Queued-job views (for the in-page queue UI) ===

export interface JobItem {
  id: string;
  accountId: string;
  conversationId: string | null;
  modelTarget: string;
  promptText: string;
  status: string;
  scheduledFor: string;
  createdAt: string;
}

export interface ListJobsResult {
  items: JobItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function listQueuedJobs(params: {
  accountId?: string;
  status?: string;
  limit?: number;
} = {}): Promise<ApiResponse<ListJobsResult>> {
  const q = new URLSearchParams();
  if (params.accountId) q.set('accountId', params.accountId);
  if (params.status) q.set('status', params.status);
  q.set('limit', String(params.limit ?? 100));
  return request<ListJobsResult>('GET', `/jobs?${q.toString()}`);
}

export async function cancelJob(id: string): Promise<ApiResponse<{ ok: boolean }>> {
  return request<{ ok: boolean }>('DELETE', `/jobs/${id}`);
}
```

- [ ] **Step 2: Import the new client fns + QueuedJob type in background**

In `apps/extension/entrypoints/background.ts`, extend the api-client import:
```ts
import {
  syncAccount,
  createJob,
  listJobs,
  healthCheck,
  listQueuedJobs,
  cancelJob,
  type CreateJobPayload,
} from '@/lib/api-client';
import type { QueuedJob } from '@/lib/queue-store';
```

- [ ] **Step 3: Add message cases**

In the `switch (message.type)` block, before `default:`:
```ts
            case 'LIST_QUEUED_JOBS':
              return await handleListQueuedJobs();

            case 'CANCEL_JOB':
              return await handleCancelJob(message.payload as { id: string });
```

- [ ] **Step 4: Add the handler functions** (next to the other `handle*` fns)
```ts
async function handleListQueuedJobs(): Promise<{ ok: boolean; jobs: QueuedJob[]; error?: string }> {
  const accountId = await getAccountId();
  if (!accountId) return { ok: true, jobs: [] };

  const res = await listQueuedJobs({ accountId, status: 'PENDING', limit: 100 });
  if (res.ok && res.data) {
    const jobs: QueuedJob[] = res.data.items.map((it) => ({
      id: it.id,
      conversationId: it.conversationId,
      promptText: it.promptText,
      modelTarget: it.modelTarget,
      scheduledFor: it.scheduledFor,
      status: it.status,
    }));
    return { ok: true, jobs };
  }
  return { ok: false, jobs: [], error: `Failed to list queued jobs (HTTP ${res.status})` };
}

async function handleCancelJob(payload: { id: string }) {
  const res = await cancelJob(payload.id);
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status, error: `Cancel failed (HTTP ${res.status})` };
}
```

- [ ] **Step 5: Typecheck + build**

Run: `cd apps/extension && pnpm exec tsc --noEmit -p . && pnpm build`
Expected: no errors; build succeeds.

- [ ] **Step 6: Commit**
```bash
git add apps/extension/lib/api-client.ts apps/extension/entrypoints/background.ts
git commit -m "feat(extension): LIST_QUEUED_JOBS + CANCEL_JOB background handlers"
```

---

## Task 5: Extension — capture conversationId + extract shared theme

**Files:**
- Create: `apps/extension/lib/theme.ts`
- Modify: `apps/extension/components/ScheduleModal.tsx`
- Modify: `apps/extension/entrypoints/background.ts`

- [ ] **Step 1: Extract the theme constants to `apps/extension/lib/theme.ts`**
```ts
/** Shared color palette matching claude.ai's dark theme. */
export const CL = {
  orange: '#da7756',
  bg: '#1f1e1c',
  surface: '#2a2a27',
  surfaceHi: '#34332f',
  border: '#3d3d38',
  text: '#e8e4dd',
  muted: '#9b9790',
  green: '#5fb37e',
} as const;
```

- [ ] **Step 2: Use the shared theme + capture conversationId in ScheduleModal**

In `apps/extension/components/ScheduleModal.tsx`:
- Add imports near the top:
```ts
import { CL } from '@/lib/theme';
import { parseConversationId } from '@/lib/conversation';
```
- Delete the local `const CL = { ... } as const;` block (now imported).
- Add `conversationId` to `ScheduleConfig`:
```ts
export interface ScheduleConfig {
  promptText: string;
  modelTarget: string;
  thinkingMode: boolean;
  scheduledAt?: string;
  conversationId?: string | null;
}
```
- In `handleSubmit`, set it on the config (right after `const config: ScheduleConfig = {...}`):
```ts
    config.conversationId = parseConversationId(location.pathname);
```

- [ ] **Step 3: Forward conversationId in background.handleQueueJob**

In `apps/extension/entrypoints/background.ts`, in `handleQueueJob`, add to the payload build:
```ts
  const payload: CreateJobPayload = {
    accountId,
    promptText: config.promptText,
    modelTarget: config.modelTarget,
    thinkingMode: config.thinkingMode,
    conversationId: config.conversationId ?? null,
    attachments: [],
  };
```

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/extension && pnpm exec tsc --noEmit -p . && pnpm build`
Expected: no errors (ScheduleModal still references `CL.*` — now from the import).

- [ ] **Step 5: Commit**
```bash
git add apps/extension/lib/theme.ts apps/extension/components/ScheduleModal.tsx apps/extension/entrypoints/background.ts
git commit -m "feat(extension): capture conversationId on queue; share theme constants"
```

---

## Task 6: Extension — shared hooks, in-chat bubbles, orchestrator wiring

**Files:**
- Create: `apps/extension/components/queue-hooks.tsx`
- Create: `apps/extension/components/QueuedBubbles.tsx`
- Modify: `apps/extension/components/QueueButton.tsx`
- Modify: `apps/extension/entrypoints/content.ts`

- [ ] **Step 1: Create shared hooks + send-time formatter `apps/extension/components/queue-hooks.tsx`**
```tsx
import { useEffect, useState } from 'react';
import type { QueueStore, QueuedJob } from '@/lib/queue-store';

/** Subscribe to the QueueStore; re-renders on any store change. */
export function useQueueJobs(store: QueueStore): QueuedJob[] {
  const [jobs, setJobs] = useState<QueuedJob[]>(store.getJobs());
  useEffect(() => store.subscribe(setJobs), [store]);
  return jobs;
}

/** Track the SPA pathname; updates on the 'cq:nav' event dispatched by content.ts. */
export function useLocationPath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const h = () => setPath(location.pathname);
    window.addEventListener('cq:nav', h);
    return () => window.removeEventListener('cq:nav', h);
  }, []);
  return path;
}

/** "in 2 hr · 7:50 PM" style label for an absolute ISO send time. */
export function formatSendTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  const diff = ms - Date.now();
  const abs = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff <= 0) return `now · ${abs}`;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins} min · ${abs}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr · ${abs}`;
  const days = Math.round(hrs / 24);
  return `in ${days} d · ${new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}
```

- [ ] **Step 2: Create the bubble component `apps/extension/components/QueuedBubbles.tsx`**
```tsx
import React, { useState } from 'react';
import type { QueueStore, QueuedJob } from '@/lib/queue-store';
import { CL } from '@/lib/theme';
import { useQueueJobs, useLocationPath, formatSendTime } from './queue-hooks';
import { parseConversationId } from '@/lib/conversation';

/** A single queued message rendered like a sent user bubble + a footer menu. */
export const QueuedCard: React.FC<{ job: QueuedJob; store: QueueStore }> = ({ job, store }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await browser.runtime.sendMessage({ type: 'CANCEL_JOB', payload: { id: job.id } });
      if (res?.ok) {
        store.remove(job.id);
      } else {
        setErr(res?.status === 409 ? 'Already sending' : 'Cancel failed');
        void store.refresh();
      }
    } catch {
      setErr('Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', margin: '12px 0' }}>
      <div style={{
        maxWidth: '75%', background: CL.surface, color: CL.text, borderRadius: 14,
        padding: '10px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        border: `1px solid ${CL.border}`,
      }}>
        {job.promptText}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 5,
        fontSize: 12, color: CL.muted,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: CL.orange }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          Sends ≈ {formatSendTime(job.scheduledFor)}
        </span>
        <button onClick={cancel} disabled={busy} style={{
          background: 'none', border: 'none', color: busy ? CL.muted : '#f87171',
          cursor: busy ? 'default' : 'pointer', fontSize: 12, padding: 0,
        }}>{busy ? 'Canceling…' : 'Cancel'}</button>
        {err && <span style={{ color: '#f87171' }}>{err}</span>}
      </div>
    </div>
  );
};

/** Renders all queued cards for the currently-open conversation. */
export const QueuedBubbles: React.FC<{ store: QueueStore }> = ({ store }) => {
  const jobs = useQueueJobs(store);
  const path = useLocationPath();
  const conversationId = parseConversationId(path);
  const mine = jobs.filter((j) => j.conversationId === conversationId);
  if (mine.length === 0) return null;
  return (
    <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', padding: '0 16px' }}>
      {mine.map((j) => <QueuedCard key={j.id} job={j} store={store} />)}
    </div>
  );
};
```

- [ ] **Step 3: Add an `onQueued` callback to QueueButton for optimistic insert**

In `apps/extension/components/QueueButton.tsx`:
- Change the component signature + props:
```tsx
import type { QueuedJob } from '@/lib/queue-store';
import { parseConversationId } from '@/lib/conversation';

export const QueueButton: React.FC<{ onQueued?: (job: QueuedJob) => void }> = ({ onQueued }) => {
```
- In `handleSubmit`, after a successful response, build and emit the optimistic job:
```ts
      if (response?.ok) {
        setLastStatus('✓ Queued');
        if (response.jobId && response.scheduledAt) {
          onQueued?.({
            id: response.jobId,
            conversationId: parseConversationId(location.pathname),
            promptText: config.promptText,
            modelTarget: config.modelTarget,
            scheduledFor: response.scheduledAt,
            status: 'PENDING',
          });
        }
        setTimeout(() => setLastStatus(null), 3000);
      } else {
```

- [ ] **Step 4: Wire the orchestrator in `content.ts`**

In `apps/extension/entrypoints/content.ts`:
- Add imports at the top:
```ts
import { QueuedBubbles } from '@/components/QueuedBubbles';
import { QueueStore, type QueuedJob } from '@/lib/queue-store';
```
- Replace the QueueButton mount block (the `root.render(React.createElement(QueueButton));` line) so the store is created and passed in, and start polling + nav events. Specifically, after `await waitForAnyContent(15000);` add:
```ts
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
```
- Change the QueueButton render to pass `onQueued`:
```ts
        root.render(React.createElement(QueueButton, { onQueued: (j: QueuedJob) => store.addOptimistic(j) }));
```
- After the QueueButton UI is mounted (end of `main`), mount the bubbles surface:
```ts
    mountQueuedBubbles(store);
```
- Add the mount helper at the bottom of the file (after the existing helper functions):
```ts
function mountQueuedBubbles(store: QueueStore) {
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-queue-bubbles';
  wrapper.style.cssText = 'width:100%;';
  const root = createRoot(wrapper);
  root.render(React.createElement(QueuedBubbles, { store }));

  const ensure = () => {
    if (wrapper.isConnected) return;
    // Anchor: just above the input composer (the contenteditable's scroll/flex
    // ancestor), so bubbles appear at the end of the thread. Walk up to a wide
    // container and insert before the composer block.
    const editable = document.querySelector('[contenteditable="true"]');
    const composer = editable?.closest('div[class*="mx-"]') ?? editable?.parentElement?.parentElement;
    if (composer?.parentElement) {
      composer.parentElement.insertBefore(wrapper, composer);
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
```

- [ ] **Step 5: Typecheck + build**

Run: `cd apps/extension && pnpm exec tsc --noEmit -p . && pnpm build && pnpm exec wxt build -b firefox`
Expected: no errors; both builds succeed.

- [ ] **Step 6: Manual verify on claude.ai (Firefox temp add-on) — adjust anchor if needed**

Load `.output/firefox-mv2` via `about:debugging`. Open an existing chat, type a prompt, queue it (End of session or +1 min). Confirm a right-aligned bubble appears with "Sends ≈ …" and a Cancel link; Cancel makes it vanish. Reload the page — the bubble persists (from the backend).
If the bubble appears in the wrong place, capture the thread DOM and adjust `mountQueuedBubbles`'s anchor:
```js
const e=document.querySelector('[contenteditable="true"]');let n=e,d=0;while(n&&d<8){console.log(d,n.tagName,typeof n.className==='string'?n.className.slice(0,60):'');n=n.parentElement;d++;}
```
Update the `composer` selector to the correct wide ancestor, rebuild, re-verify.

- [ ] **Step 7: Commit**
```bash
git add apps/extension/components/queue-hooks.tsx apps/extension/components/QueuedBubbles.tsx apps/extension/components/QueueButton.tsx apps/extension/entrypoints/content.ts
git commit -m "feat(extension): in-chat queued bubbles with cancel + store orchestration"
```

---

# PHASE 2 — "Queued" sidebar section

## Task 7: Extension — QueuedSidebar

**Files:**
- Create: `apps/extension/components/QueuedSidebar.tsx`
- Modify: `apps/extension/entrypoints/content.ts`

- [ ] **Step 1: Create `apps/extension/components/QueuedSidebar.tsx`**
```tsx
import React from 'react';
import type { QueueStore, QueuedJob } from '@/lib/queue-store';
import { CL } from '@/lib/theme';
import { useQueueJobs } from './queue-hooks';

interface Entry {
  key: string;
  label: string;
  count: number;
  conversationId: string | null; // null = new-chat pseudo entry
  newChatJobId?: string;          // set for new-chat entries
}

/** Reuse claude's own sidebar title for an existing chat, else a prompt preview. */
function titleForConversation(conversationId: string, fallback: string): string {
  const link = document.querySelector(`a[href$="/chat/${conversationId}"]`);
  const text = link?.textContent?.trim();
  return text && text.length > 0 ? text : fallback;
}

function buildEntries(jobs: QueuedJob[]): Entry[] {
  const byConversation = new Map<string, QueuedJob[]>();
  const newChats: QueuedJob[] = [];
  for (const j of jobs) {
    if (j.conversationId) {
      const arr = byConversation.get(j.conversationId) ?? [];
      arr.push(j);
      byConversation.set(j.conversationId, arr);
    } else {
      newChats.push(j);
    }
  }
  const entries: Entry[] = [];
  for (const [cid, arr] of byConversation) {
    const preview = arr[0].promptText.slice(0, 32);
    entries.push({ key: cid, label: titleForConversation(cid, preview), count: arr.length, conversationId: cid });
  }
  for (const j of newChats) {
    entries.push({ key: j.id, label: j.promptText.slice(0, 32) || 'New chat', count: 1, conversationId: null, newChatJobId: j.id });
  }
  return entries;
}

export const QueuedSidebar: React.FC<{ store: QueueStore }> = ({ store }) => {
  const jobs = useQueueJobs(store);
  if (jobs.length === 0) return null;
  const entries = buildEntries(jobs);

  const onClick = (e: Entry) => {
    if (e.conversationId) {
      location.assign(`https://claude.ai/chat/${e.conversationId}`);
    } else if (e.newChatJobId) {
      window.dispatchEvent(new CustomEvent('cq:open-pseudo', { detail: { id: e.newChatJobId } }));
    }
  };

  return (
    <div style={{ padding: '8px 8px 4px' }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
        color: CL.muted, padding: '4px 8px',
      }}>
        Queued ({jobs.length})
      </div>
      {entries.map((e) => (
        <button key={e.key} onClick={() => onClick(e)} title={e.label} style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer', color: CL.text,
          padding: '6px 8px', borderRadius: 8, fontSize: 13,
        }}
          onMouseEnter={(ev) => { ev.currentTarget.style.background = CL.surface; }}
          onMouseLeave={(ev) => { ev.currentTarget.style.background = 'none'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={CL.orange} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
          {e.count > 1 && <span style={{ fontSize: 11, color: CL.muted }}>{e.count}</span>}
        </button>
      ))}
    </div>
  );
};
```

- [ ] **Step 2: Mount it from `content.ts`**

Add the import:
```ts
import { QueuedSidebar } from '@/components/QueuedSidebar';
```
Call it after `mountQueuedBubbles(store);`:
```ts
    mountQueuedSidebar(store);
```
Add the mount helper at the bottom of `content.ts`:
```ts
function mountQueuedSidebar(store: QueueStore) {
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-queue-sidebar';
  const root = createRoot(wrapper);
  root.render(React.createElement(QueuedSidebar, { store }));

  const ensure = () => {
    if (wrapper.isConnected) return;
    // Anchor: top of the chat-history nav. Find a nav list that contains chat
    // links and insert our section before it.
    const navLink = document.querySelector('nav a[href^="/chat/"], a[href^="/chat/"]');
    const list = navLink?.closest('nav') ?? navLink?.parentElement?.parentElement;
    if (list?.parentElement) {
      list.parentElement.insertBefore(wrapper, list);
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
```

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/extension && pnpm exec tsc --noEmit -p . && pnpm exec wxt build -b firefox`
Expected: no errors; build succeeds.

- [ ] **Step 4: Manual verify + adjust anchor if needed**

Reload the temp add-on. With ≥1 queued message, a "Queued (n)" section appears in the left sidebar. Existing-chat entries navigate to the chat on click; multiple queued in one chat show a count. If the section is mis-anchored, dump the sidebar DOM and adjust the selector:
```js
const a=document.querySelector('a[href^="/chat/"]');let n=a,d=0;while(n&&d<8){console.log(d,n.tagName,typeof n.className==='string'?n.className.slice(0,60):'');n=n.parentElement;d++;}
```

- [ ] **Step 5: Commit**
```bash
git add apps/extension/components/QueuedSidebar.tsx apps/extension/entrypoints/content.ts
git commit -m "feat(extension): Queued sidebar section grouped by chat with new-chat entries"
```

---

# PHASE 3 — Pseudo-chat overlay

## Task 8: Extension — PseudoChat overlay

**Files:**
- Create: `apps/extension/components/PseudoChat.tsx`
- Modify: `apps/extension/entrypoints/content.ts`

- [ ] **Step 1: Create `apps/extension/components/PseudoChat.tsx`**
```tsx
import React, { useEffect, useState } from 'react';
import type { QueueStore } from '@/lib/queue-store';
import { CL } from '@/lib/theme';
import { useQueueJobs } from './queue-hooks';
import { QueuedCard } from './QueuedBubbles';

/**
 * Overlay that simulates a chat window for a message queued into a NEW chat.
 * Opened via the 'cq:open-pseudo' event (detail.id = job id). No input box.
 */
export const PseudoChat: React.FC<{ store: QueueStore }> = ({ store }) => {
  const jobs = useQueueJobs(store);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => setOpenId((e as CustomEvent).detail?.id ?? null);
    const close = () => setOpenId(null);
    window.addEventListener('cq:open-pseudo', open);
    window.addEventListener('cq:close-pseudo', close);
    return () => {
      window.removeEventListener('cq:open-pseudo', open);
      window.removeEventListener('cq:close-pseudo', close);
    };
  }, []);

  if (!openId) return null;
  const job = jobs.find((j) => j.id === openId);
  // The job vanished (canceled or sent) → close the overlay.
  if (!job) { if (openId) setTimeout(() => setOpenId(null), 0); return null; }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999998, background: CL.bg,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', borderBottom: `1px solid ${CL.border}`,
      }}>
        <span style={{ color: CL.text, fontSize: 15, fontWeight: 600 }}>Queued · new chat</span>
        <button onClick={() => setOpenId(null)} style={{
          background: 'none', border: 'none', color: CL.muted, fontSize: 24, cursor: 'pointer', lineHeight: 1,
        }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div style={{ color: CL.muted, fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
            This message hasn’t been sent yet — it will start a new chat when it sends.
          </div>
          <QueuedCard job={job} store={store} />
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Mount it from `content.ts`**

Add the import:
```ts
import { PseudoChat } from '@/components/PseudoChat';
```
After `mountQueuedSidebar(store);` add:
```ts
    mountPseudoChat(store);
```
Add the mount helper at the bottom of `content.ts` (overlay attaches to body and is always connected):
```ts
function mountPseudoChat(store: QueueStore) {
  const wrapper = document.createElement('div');
  wrapper.id = 'claude-queue-pseudo';
  document.body.appendChild(wrapper);
  createRoot(wrapper).render(React.createElement(PseudoChat, { store }));
}
```

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/extension && pnpm exec tsc --noEmit -p . && pnpm exec wxt build -b firefox`
Expected: no errors; build succeeds.

- [ ] **Step 4: Manual verify**

Reload the temp add-on. Queue a message from a **new** chat (`/new`, no conversation open). A new-chat entry appears in the "Queued" sidebar. Click it → an overlay opens showing the queued bubble + "Sends ≈ …" + Cancel, with **no input box**. Cancel closes the overlay and removes the entry; the × closes it leaving claude.ai unchanged.

- [ ] **Step 5: Commit**
```bash
git add apps/extension/components/PseudoChat.tsx apps/extension/entrypoints/content.ts
git commit -m "feat(extension): pseudo-chat overlay for messages queued into new chats"
```

---

## Task 9: Full verification

- [ ] **Step 1: Unit tests**

Run: `pnpm --filter @claude-queue/extension test`
Expected: all tests PASS (reset-parser, conversation, queue-store).

- [ ] **Step 2: Typecheck + both builds**

Run:
```bash
cd apps/extension && pnpm exec tsc --noEmit -p . && pnpm build && pnpm exec wxt build -b firefox
```
Expected: no type errors; chrome-mv3 + firefox-mv2 builds succeed.

- [ ] **Step 3: End-to-end manual pass on claude.ai**

With the API/worker stack running and the temp add-on loaded:
- Queue into the current chat → bubble + sidebar entry appear; "Sends ≈" correct; reload persists them.
- Queue ≥2 into the same chat → sidebar shows a count badge.
- Queue into a new chat → sidebar new-chat entry → pseudo-chat overlay (no input box).
- Cancel from a bubble and from the overlay → removed everywhere; backend `DELETE` returns ok.
- Let a near-term job actually fire (or short delay) → placeholder disappears on the next poll and the real message is present.

- [ ] **Step 4: Final commit (only if manual fixes were needed)**
```bash
git add -A
git commit -m "chore(extension): verification fixes for queued-message visibility"
```

---

## Notes for the implementer

- WXT auto-imports: `storage`, `browser`, `defineBackground`, `defineContentScript`, `createRoot` is imported explicitly in `content.ts` already. Do not add CSS imports — inline styles only.
- The in-chat bubble anchor (Task 6) and sidebar anchor (Task 7) are best-effort selectors; claude.ai's markup may differ. Each mount no-ops safely until its anchor is found, and Tasks 6/7 include DOM-dump snippets to correct the selector against the live page — expect one adjustment round, exactly as was needed for the Queue button's mic anchor.
- `response.jobId` / `response.scheduledAt` come from `handleQueueJob`'s return shape in `background.ts` (already returns `{ ok, jobId, scheduledAt }`).
- Cancellation only succeeds while a job is PENDING; the UI surfaces a 409 as "Already sending" and refreshes.
</content>
