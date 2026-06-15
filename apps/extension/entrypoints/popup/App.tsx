import React, { useState, useEffect, useCallback } from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import {
  getConfig,
  setBackendUrl,
  setAdminToken,
  type ExtensionConfig,
} from '@/lib/storage';

interface StatusInfo {
  backendConnected: boolean;
  accountId: string | null;
  accountName: string | null;
}

interface JobSummary {
  jobId: string;
  promptText: string;
  modelTarget: string;
  status: string;
  scheduledAt: string | null;
  createdAt: string;
}

export const App: React.FC = () => {
  const [config, setConfig] = useState<ExtensionConfig>({
    backendUrl: null,
    adminToken: null,
    accountId: null,
    accountName: null,
  });
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [status, setStatus] = useState<StatusInfo>({
    backendConnected: false,
    accountId: null,
    accountName: null,
  });
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCreatingWorker, setIsCreatingWorker] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  // Load config on mount
  useEffect(() => {
    loadConfig();
    refreshStatus();
  }, []);

  const loadConfig = async () => {
    const cfg = await getConfig();
    setConfig(cfg);
    setUrlInput(cfg.backendUrl ?? '');
    setTokenInput(cfg.adminToken ?? '');
  };

  const refreshStatus = async () => {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'GET_STATUS',
      });
      if (response?.ok) {
        setStatus({
          backendConnected: response.backendConnected,
          accountId: response.accountId,
          accountName: response.accountName,
        });
      }
    } catch {
      // Background script not ready
    }

    // Fetch recent jobs
    try {
      const jobsResponse = await browser.runtime.sendMessage({
        type: 'LIST_JOBS',
      });
      if (jobsResponse?.ok && jobsResponse.jobs) {
        setJobs(jobsResponse.jobs);
      }
    } catch {
      // Ignore
    }
  };

  const handleSaveUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    await setBackendUrl(url);
    setConfig((prev) => ({ ...prev, backendUrl: url }));
    showMessage('Backend URL saved', 'success');
    // Re-check status
    setTimeout(refreshStatus, 500);
  }, [urlInput]);

  const handleSaveToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token) return;
    await setAdminToken(token);
    setConfig((prev) => ({ ...prev, adminToken: token }));
    showMessage('Admin token saved', 'success');
  }, [tokenInput]);

  const handlePairAccount = useCallback(async () => {
    setIsSyncing(true);
    try {
      const response = await browser.runtime.sendMessage({
        type: 'SYNC_SESSION',
      });
      if (response?.ok) {
        showMessage(
          `Account paired: ${response.accountName ?? response.accountId}`,
          'success',
        );
        await loadConfig();
        await refreshStatus();
      } else {
        showMessage(response?.error ?? 'Pairing failed', 'error');
      }
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : 'Pairing failed',
        'error',
      );
    } finally {
      setIsSyncing(false);
    }
  }, []);

  const handleCreateWorkerSession = useCallback(async () => {
    setIsCreatingWorker(true);
    try {
      const response = await browser.runtime.sendMessage({
        type: 'CREATE_WORKER_SESSION',
      });
      if (response?.ok) {
        showMessage(
          'Worker session created! Worker now uses its own login.',
          'success',
        );
        await refreshStatus();
      } else {
        showMessage(response?.error ?? 'Worker session creation failed', 'error');
      }
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : 'Worker session creation failed',
        'error',
      );
    } finally {
      setIsCreatingWorker(false);
    }
  }, []);

  const showMessage = (text: string, type: 'success' | 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const statusColor = (s: string): string => {
    switch (s) {
      case 'PENDING':
        return 'text-yellow-400';
      case 'PROCESSING':
        return 'text-blue-400';
      case 'COMPLETED':
        return 'text-green-400';
      case 'FAILED':
        return 'text-red-400';
      default:
        return 'text-claude-text-muted';
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-claude-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">⏰</span>
            <h1 className="text-base font-semibold">Claude Queue</h1>
          </div>
          <StatusBadge
            status={
              status.accountId
                ? 'synced'
                : status.backendConnected
                  ? 'connected'
                  : 'disconnected'
            }
          />
        </div>
      </div>

      {/* Toast Message */}
      {message && (
        <div
          className={`mx-4 mt-3 px-3 py-2 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Config Section */}
      <div className="px-4 py-3 space-y-3">
        {/* Backend URL */}
        <div>
          <label className="block text-xs font-medium text-claude-text-muted mb-1">
            Backend URL
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="http://localhost:3000"
              className="flex-1 px-2.5 py-1.5 bg-claude-surface border border-claude-border rounded-lg text-sm text-claude-text placeholder:text-claude-text-muted/50 focus:outline-none focus:border-claude-orange"
            />
            <button
              onClick={handleSaveUrl}
              className="px-3 py-1.5 bg-claude-surface hover:bg-claude-border border border-claude-border rounded-lg text-xs font-medium text-claude-text transition-colors"
            >
              Save
            </button>
          </div>
        </div>

        {/* Admin Token */}
        <div>
          <label className="block text-xs font-medium text-claude-text-muted mb-1">
            Admin Token
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="your-admin-token"
              className="flex-1 px-2.5 py-1.5 bg-claude-surface border border-claude-border rounded-lg text-sm text-claude-text placeholder:text-claude-text-muted/50 focus:outline-none focus:border-claude-orange"
            />
            <button
              onClick={handleSaveToken}
              className="px-3 py-1.5 bg-claude-surface hover:bg-claude-border border border-claude-border rounded-lg text-xs font-medium text-claude-text transition-colors"
            >
              Save
            </button>
          </div>
        </div>

        {/* Pair Account */}
        <button
          onClick={handlePairAccount}
          disabled={isSyncing || !config.backendUrl}
          className="w-full px-4 py-2 bg-claude-orange hover:bg-claude-orange/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
        >
          {isSyncing ? 'Syncing...' : '🔗 Pair Account'}
        </button>

        {/* Create Worker Session (separate login for the worker) */}
        {status.accountId && (
          <button
            onClick={handleCreateWorkerSession}
            disabled={isCreatingWorker}
            className="w-full px-4 py-2 bg-claude-surface hover:bg-claude-border border border-claude-border text-claude-text font-medium rounded-lg transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingWorker ? 'Creating...' : '🔐 Create Worker Session'}
          </button>
        )}

        {/* Account Info */}
        {status.accountName && (
          <div className="flex items-center gap-2 px-3 py-2 bg-claude-surface rounded-lg border border-claude-border">
            <span className="text-sm">👤</span>
            <span className="text-sm text-claude-text">
              {status.accountName}
            </span>
            <span className="text-xs text-claude-text-muted ml-auto">
              {status.accountId?.slice(0, 8)}…
            </span>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-claude-border" />

      {/* Jobs Section */}
      <div className="px-4 py-3 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-claude-text-muted">
            Recent Jobs
          </h2>
          <button
            onClick={refreshStatus}
            className="text-xs text-claude-text-muted hover:text-claude-text transition-colors"
          >
            ↻ Refresh
          </button>
        </div>

        {jobs.length === 0 ? (
          <div className="text-center py-6 text-sm text-claude-text-muted">
            No queued jobs yet.
            <br />
            <span className="text-xs">
              Use the ⏰ button on claude.ai to queue messages.
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.jobId}
                className="px-3 py-2 bg-claude-surface rounded-lg border border-claude-border"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-claude-text line-clamp-2 flex-1">
                    {job.promptText.length > 60
                      ? `${job.promptText.slice(0, 60)}…`
                      : job.promptText}
                  </p>
                  <span
                    className={`text-xs font-medium whitespace-nowrap ${statusColor(job.status)}`}
                  >
                    {job.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-claude-text-muted">
                    {job.modelTarget.split('-').slice(0, 2).join('-')}
                  </span>
                  <span className="text-xs text-claude-text-muted">·</span>
                  <span className="text-xs text-claude-text-muted">
                    {formatTime(job.scheduledAt ?? job.createdAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-claude-border text-center">
        <span className="text-xs text-claude-text-muted">
          Claude Queue v2.0
        </span>
      </div>
    </div>
  );
};
