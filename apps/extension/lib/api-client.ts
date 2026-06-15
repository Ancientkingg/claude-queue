import type { AccountSessionProfile, QueueJob } from '@claude-queue/shared-types';
import { getBackendUrl, getAdminToken } from './storage';

/**
 * API client for the Claude Queue backend.
 */

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

async function getHeaders(): Promise<Record<string, string>> {
  const token = await getAdminToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function getBaseUrl(): Promise<string> {
  const url = await getBackendUrl();
  if (!url) {
    throw new Error('Backend URL not configured. Set it in the extension popup.');
  }
  return url.replace(/\/+$/, ''); // strip trailing slashes
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    data = null as T;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

// === Account endpoints ===

export interface SyncAccountResponse {
  accountId: string;
  accountName: string;
  status: string;
}

export async function syncAccount(
  accountName: string,
  sessionProfile: AccountSessionProfile,
): Promise<ApiResponse<SyncAccountResponse>> {
  return request<SyncAccountResponse>('POST', '/accounts/sync', {
    accountName,
    sessionProfile,
  });
}

// === Job endpoints ===

export interface CreateJobPayload {
  accountId: string;
  conversationId?: string | null;
  modelTarget: string;
  promptText: string;
  thinkingMode: boolean;
  attachments?: Array<{
    storageKey: string;
    fileName: string;
    mimeType: string;
  }>;
  scheduledFor?: string; // ISO 8601
  delaySeconds?: number;
}

export interface CreateJobResponse {
  id: string;
  scheduledFor: string;
  status: string;
}

export async function createJob(
  payload: CreateJobPayload,
): Promise<ApiResponse<CreateJobResponse>> {
  return request<CreateJobResponse>('POST', '/jobs', payload);
}

export interface JobSummary {
  jobId: string;
  accountId: string;
  promptText: string;
  modelTarget: string;
  status: string;
  scheduledAt: string | null;
  createdAt: string;
}

export interface ListJobsResponse {
  jobs: JobSummary[];
  total: number;
}

export async function listJobs(
  limit = 5,
): Promise<ApiResponse<ListJobsResponse>> {
  return request<ListJobsResponse>('GET', `/jobs?limit=${limit}`);
}

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

// === Health check ===

export interface HealthResponse {
  status: string;
  version?: string;
}

export async function healthCheck(): Promise<ApiResponse<HealthResponse>> {
  return request<HealthResponse>('GET', '/health');
}
