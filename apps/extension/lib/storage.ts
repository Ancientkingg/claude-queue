import type { ResetInfo } from './reset-parser';

// --- Storage keys ---
const BACKEND_URL_KEY = 'local:backendUrl';
const ADMIN_TOKEN_KEY = 'local:adminToken';
const ACCOUNT_ID_KEY = 'local:accountId';
const ACCOUNT_NAME_KEY = 'local:accountName';
const RESET_INFO_KEY = 'local:resetInfo';

// --- Getters ---

export async function getBackendUrl(): Promise<string | null> {
  return storage.getItem<string>(BACKEND_URL_KEY);
}

export async function getAdminToken(): Promise<string | null> {
  return storage.getItem<string>(ADMIN_TOKEN_KEY);
}

export async function getAccountId(): Promise<string | null> {
  return storage.getItem<string>(ACCOUNT_ID_KEY);
}

export async function getAccountName(): Promise<string | null> {
  return storage.getItem<string>(ACCOUNT_NAME_KEY);
}

// --- Setters ---

export async function setBackendUrl(url: string): Promise<void> {
  await storage.setItem(BACKEND_URL_KEY, url);
}

export async function setAdminToken(token: string): Promise<void> {
  await storage.setItem(ADMIN_TOKEN_KEY, token);
}

export async function setAccountId(id: string): Promise<void> {
  await storage.setItem(ACCOUNT_ID_KEY, id);
}

export async function setAccountName(name: string): Promise<void> {
  await storage.setItem(ACCOUNT_NAME_KEY, name);
}

// --- Usage-reset info (captured from claude.ai rate-limit headers) ---

export async function getResetInfo(): Promise<ResetInfo | null> {
  return storage.getItem<ResetInfo>(RESET_INFO_KEY);
}

export async function setResetInfo(info: ResetInfo): Promise<void> {
  await storage.setItem(RESET_INFO_KEY, info);
}

// --- Bulk operations ---

export interface ExtensionConfig {
  backendUrl: string | null;
  adminToken: string | null;
  accountId: string | null;
  accountName: string | null;
}

export async function getConfig(): Promise<ExtensionConfig> {
  const [backendUrl, adminToken, accountId, accountName] = await Promise.all([
    getBackendUrl(),
    getAdminToken(),
    getAccountId(),
    getAccountName(),
  ]);
  return { backendUrl, adminToken, accountId, accountName };
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    storage.removeItem(BACKEND_URL_KEY),
    storage.removeItem(ADMIN_TOKEN_KEY),
    storage.removeItem(ACCOUNT_ID_KEY),
    storage.removeItem(ACCOUNT_NAME_KEY),
  ]);
}
