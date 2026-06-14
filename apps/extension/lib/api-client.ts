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
  sessionProfile: AccountSessionProfile,
): Promise<ApiResponse<SyncAccountResponse>> {
  return request<SyncAccountResponse>('POST', '/accounts/sync', sessionProfile);
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
  scheduledAt?: string; // ISO 8601
  delaySeconds?: number;
}

export interface CreateJobResponse {
  jobId: string;
  status: string;
  scheduledAt: string;
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

// === Health check ===

export interface HealthResponse {
  status: string;
  version?: string;
}

export async function healthCheck(): Promise<ApiResponse<HealthResponse>> {
  return request<HealthResponse>('GET', '/health');
}
