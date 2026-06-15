import { harvestSession } from '@/lib/session-harvester';
import {
  syncAccount,
  createJob,
  listJobs,
  healthCheck,
  type CreateJobPayload,
} from '@/lib/api-client';
import {
  getAccountId,
  setAccountId,
  setAccountName,
  getConfig,
} from '@/lib/storage';
import type { ScheduleConfig } from '@/components/ScheduleModal';

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
  const errorData = response.data as Record<string, unknown> | null;
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
    attachments: [],
  };

  if (config.scheduledAt) {
    payload.scheduledAt = config.scheduledAt;
  } else if (config.delaySeconds) {
    payload.delaySeconds = config.delaySeconds;
  }

  const response = await createJob(payload);

  if (response.ok && response.data) {
    return {
      ok: true,
      jobId: response.data.jobId,
      scheduledAt: response.data.scheduledAt,
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
