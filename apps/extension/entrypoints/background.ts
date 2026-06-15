import { harvestSession, harvestWorkerSession } from '@/lib/session-harvester';
import {
  syncAccount,
  syncWorkerSession,
  createJob,
  listJobs,
  healthCheck,
  listQueuedJobs,
  cancelJob,
  type CreateJobPayload,
} from '@/lib/api-client';
import {
  getAccountId,
  setAccountId,
  setAccountName,
  getConfig,
  getResetInfo,
  setResetInfo,
} from '@/lib/storage';
import { parseResetTimestamp } from '@/lib/reset-parser';
import type { ScheduleConfig } from '@/components/ScheduleModal';
import type { QueuedJob } from '@/lib/queue-store';

export default defineBackground(() => {
  console.log('[Claude Queue] Background script loaded');

  // Listen for messages from content script and popup
  browser.runtime.onMessage.addListener(
    (
      message: { type: string; payload?: unknown },
      _sender: any,
      sendResponse: (response?: unknown) => void,
    ) => {
      // Handle async responses
      const handleAsync = async () => {
        try {
          switch (message.type) {
            case 'SYNC_SESSION':
              return await handleSyncSession();

            case 'QUEUE_JOB':
              return await handleQueueJob(message.payload as ScheduleConfig);

            case 'GET_STATUS':
              return await handleGetStatus();

            case 'LIST_JOBS':
              return await handleListJobs();

            case 'HEALTH_CHECK':
              return await handleHealthCheck();

            case 'GET_RESET_TIME':
              return await handleGetResetTime();

            case 'LIST_QUEUED_JOBS':
              return await handleListQueuedJobs();

            case 'CREATE_WORKER_SESSION':
              return await handleCreateWorkerSession();

            case 'CANCEL_JOB':
              return await handleCancelJob(message.payload as { id: string });

            default:
              return { ok: false, error: `Unknown message type: ${message.type}` };
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[Claude Queue] Error handling ${message.type}:`, err);
          return { ok: false, error: errorMsg };
        }
      };

      handleAsync().then(sendResponse);
      return true; // Keep the message channel open for async response
    },
  );
});

/**
 * Fetch claude.ai's 5-hour usage-window reset time directly from the same REST
 * endpoint the Settings → Usage page uses — no message needs to be sent. The
 * org id comes from the `lastActiveOrg` cookie; the request rides the user's
 * claude.ai cookies (credentials: 'include') and bypasses CORS because
 * claude.ai is in host_permissions. Returns reset epoch-ms, or null.
 */
async function fetchUsageReset(): Promise<number | null> {
  try {
    const cookie = await browser.cookies.get({
      url: 'https://claude.ai',
      name: 'lastActiveOrg',
    });
    const orgId = cookie?.value;
    if (!orgId) return null;

    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { five_hour?: { resets_at?: string | number } };
    const resetAtMs = parseResetTimestamp(data?.five_hour?.resets_at);
    if (resetAtMs != null) {
      await setResetInfo({ resetAtMs, capturedAtMs: Date.now() });
      return resetAtMs;
    }
    return null;
  } catch (err) {
    console.error('[Claude Queue] Failed to fetch usage reset:', err);
    return null;
  }
}

async function handleSyncSession() {
  const session = await harvestSession();

  // Try to extract account name from localStorage (claude.ai stores user profile)
  let accountName = 'My Account';
  const ls = session.localStorageSnapshot;
  if (ls) {
    // Claude.ai stores user info in various keys — try common ones
    const raw = ls['user'] || ls['profile'] || ls['CurrentUser'];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        accountName = parsed?.name || parsed?.email || parsed?.full_name || accountName;
      } catch {
        // Not JSON
      }
    }
  }

  const response = await syncAccount(accountName, session);

  if (response.ok && response.data) {
    await setAccountId(response.data.accountId);
    await setAccountName(response.data.accountName);
    return {
      ok: true,
      accountId: response.data.accountId,
      accountName: response.data.accountName,
      status: response.data.status,
    };
  }

  // Surface validation errors from the API
  const errorData = response.data as unknown as Record<string, unknown> | null;
  const validationErrors = errorData?.['errors'] as Array<{ path: string; message: string }> | undefined;
  const detail = validationErrors?.map((e) => `${e.path}: ${e.message}`).join(', ') ?? '';
  console.error('[Claude Queue] Sync failed:', response.status, detail || errorData);

  return {
    ok: false,
    error: detail
      ? `Sync failed (HTTP ${response.status}): ${detail}`
      : `Sync failed (HTTP ${response.status})`,
  };
}

async function handleQueueJob(config: ScheduleConfig) {
  const accountId = await getAccountId();
  if (!accountId) {
    return {
      ok: false,
      error: 'No account paired. Pair your account in the popup first.',
    };
  }

  const payload: CreateJobPayload = {
    accountId,
    promptText: config.promptText,
    modelTarget: config.modelTarget,
    thinkingMode: config.thinkingMode,
    conversationId: config.conversationId ?? null,
    attachments: [],
  };

  if (config.scheduledAt) {
    payload.scheduledFor = config.scheduledAt;
  }

  const response = await createJob(payload);

  if (response.ok && response.data) {
    return {
      ok: true,
      jobId: response.data.id,
      scheduledAt: response.data.scheduledFor,
    };
  }

  return {
    ok: false,
    error: `Job creation failed (HTTP ${response.status})`,
  };
}

async function handleGetStatus() {
  const config = await getConfig();
  let backendConnected = false;

  if (config.backendUrl) {
    try {
      const health = await healthCheck();
      backendConnected = health.ok;
    } catch {
      backendConnected = false;
    }
  }

  return {
    ok: true,
    backendUrl: config.backendUrl,
    backendConnected,
    accountId: config.accountId,
    accountName: config.accountName,
  };
}

async function handleListJobs() {
  const response = await listJobs(5);

  if (response.ok && response.data) {
    return {
      ok: true,
      jobs: response.data.jobs,
      total: response.data.total,
    };
  }

  return {
    ok: false,
    error: `Failed to list jobs (HTTP ${response.status})`,
    jobs: [],
  };
}

const RESET_CACHE_TTL_MS = 60_000;

async function handleGetResetTime() {
  // Serve a recent cached value to avoid hammering the endpoint while the
  // modal polls; otherwise fetch fresh from claude.ai.
  const cached = await getResetInfo();
  if (cached && Date.now() - cached.capturedAtMs < RESET_CACHE_TTL_MS) {
    return { ok: true, resetAtMs: cached.resetAtMs, capturedAtMs: cached.capturedAtMs };
  }

  const resetAtMs = await fetchUsageReset();
  if (resetAtMs != null) {
    return { ok: true, resetAtMs, capturedAtMs: Date.now() };
  }

  // Fall back to any stale-but-valid stored value (the window may not have
  // passed yet even if it's older than the cache TTL).
  if (cached) {
    return { ok: true, resetAtMs: cached.resetAtMs, capturedAtMs: cached.capturedAtMs };
  }
  return { ok: false, error: 'Could not retrieve usage reset time' };
}

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

async function handleCreateWorkerSession() {
  try {
    // 1. Open incognito window and harvest the worker session
    const session = await harvestWorkerSession();

    // 2. Get the account ID from storage
    const accountId = await getAccountId();
    if (!accountId) {
      return {
        ok: false,
        error: 'No account paired. Pair your account first.',
      };
    }

    // 3. Send to API
    const response = await syncWorkerSession(accountId, session);

    if (response.ok && response.data) {
      return {
        ok: true,
        accountId: response.data.accountId,
        hasWorkerSession: response.data.hasWorkerSession,
      };
    }

    return {
      ok: false,
      error: `Worker session sync failed (HTTP ${response.status})`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Claude Queue] Worker session creation failed:', err);
    return { ok: false, error: errorMsg };
  }
}

async function handleHealthCheck() {
  try {
    const response = await healthCheck();
    return { ok: response.ok, data: response.data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Health check failed',
    };
  }
}
