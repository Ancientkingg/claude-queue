/**
 * FlareSolverr integration — uses a self-hosted FlareSolverr instance to
 * solve Cloudflare challenges before Playwright navigation.
 *
 * Flow:
 *  1. Create a persistent FlareSolverr session (reuses browser across requests).
 *  2. Request the target claude.ai URL through FlareSolverr.
 *  3. FlareSolverr returns Cloudflare-clearance cookies (cf_clearance, etc.)
 *     plus a User-Agent string that matches the browser that solved the challenge.
 *  4. Inject those cookies into the Playwright context alongside the user's
 *     auth cookies so Cloudflare sees us as already-verified.
 *  5. Navigate with Playwright — no challenge appears.
 *
 * If FlareSolverr is unreachable or returns an error, we return null so the
 * caller can fall back to the existing checkForBlock → CAPTCHA solving chain.
 *
 * Env vars:
 *  - FLARESOLVERR_URL   Base URL of the FlareSolverr instance (default http://localhost:8191)
 */

import { config } from '../config.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface FlareSolverrCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;   // Unix timestamp
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  size?: number;
}

export interface FlareSolverrSession {
  sessionId: string;
}

export interface FlareSolverrSolution {
  cookies: FlareSolverrCookie[];
  userAgent: string;
  /** Optional Turnstile token if a CAPTCHA was solved. */
  turnstileToken?: string;
}

interface FlareSolverrResponse {
  status: 'ok' | 'error';
  message?: string;
  startTimestamp: number;
  endTimestamp: number;
  version: string;
  solution?: {
    url?: string;
    status?: number;
    response?: string;
    cookies?: FlareSolverrCookie[];
    userAgent?: string;
    turnstile_token?: string;
  };
  /** v1 error shape */
  error?: string;
  error_description?: string;
}

// ─── Client ───────────────────────────────────────────────────────────────

const FLARESOLR_V1 = `${config.flareSolverrUrl}/v1`;

async function callFlareSolverr(body: Record<string, unknown>): Promise<FlareSolverrResponse> {
  const res = await fetch(FLARESOLR_V1, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`FlareSolverr returned HTTP ${res.status}`);
  }

  return (await res.json()) as FlareSolverrResponse;
}

// ─── Session management ───────────────────────────────────────────────────

let activeSession: string | null = null;

/**
 * Create (or reuse) a persistent FlareSolverr browser session.
 * Reusing the same session avoids the overhead of launching a new
 * browser for every job and preserves cookies across requests.
 */
export async function getOrCreateSession(): Promise<string> {
  if (activeSession) {
    try {
      // Verify it still exists
      const res = await callFlareSolverr({ cmd: 'sessions.list' });
      const sessions: string[] = (res as any).sessions ?? [];
      if (sessions.includes(activeSession)) {
        return activeSession;
      }
      // Session was garbage-collected on the server
      console.log('  🔄 FlareSolverr session expired, creating new one');
      activeSession = null;
    } catch {
      // Server may have restarted — create a fresh session
      activeSession = null;
    }
  }

  const res = await callFlareSolverr({
    cmd: 'sessions.create',
    ...(config.flareSolverrProxy ? {
      proxy: { url: config.flareSolverrProxy },
    } : {}),
  });

  activeSession = (res as any).session as string;
  console.log(`  🦾 FlareSolverr session created: ${activeSession}`);
  return activeSession!;
}

/**
 * Destroy the active FlareSolverr session (used during graceful shutdown).
 */
export async function destroySession(): Promise<void> {
  if (!activeSession) return;
  try {
    await callFlareSolverr({ cmd: 'sessions.destroy', session: activeSession });
    console.log(`  🦾 FlareSolverr session destroyed: ${activeSession}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️  FlareSolverr session destroy error: ${msg}`);
  }
  activeSession = null;
}

// ─── Challenge solving ────────────────────────────────────────────────────

/**
 * Use FlareSolverr to fetch a URL and return the Cloudflare-clearance cookies
 * and User-Agent. Returns null if FlareSolverr is unreachable or the challenge
 * could not be solved.
 *
 * @param url        - Target URL (e.g. https://claude.ai/chat/<uuid>)
 * @param maxTimeout - How long FlareSolverr should wait for the challenge (ms)
 */
export async function solveViaFlareSolverr(
  url: string,
  maxTimeout: number = 60_000,
  forceFresh: boolean = false,
): Promise<FlareSolverrSolution | null> {
  try {
    // Destroy the current session if it's been burned by Cloudflare
    if (forceFresh && activeSession) {
      try {
        await callFlareSolverr({ cmd: 'sessions.destroy', session: activeSession });
      } catch { /* ignore */ }
      activeSession = null;
      console.log('  🔄 FlareSolverr burned session discarded, creating fresh one');
    }

    const sessionId = await getOrCreateSession();

    console.log(`  🦾 FlareSolverr solving: ${url}`);

    const res = await callFlareSolverr({
      cmd: 'request.get',
      session: sessionId,
      url,
      maxTimeout,
      returnOnlyCookies: true, // We only need cookies, not the full page
    });

    if (res.status === 'error') {
      const detail = res.message ?? res.error_description ?? res.error ?? 'unknown';
      console.warn(`  ⚠️  FlareSolverr error: ${detail}`);
      return null;
    }

    const cookies = res.solution?.cookies ?? [];
    const userAgent = res.solution?.userAgent ?? '';
    const turnstileToken = res.solution?.turnstile_token;

    if (cookies.length === 0) {
      console.warn('  ⚠️  FlareSolverr returned no cookies');
      return null;
    }

    const elapsed = ((res.endTimestamp - res.startTimestamp) / 1000).toFixed(1);
    console.log(`  ✅ FlareSolverr solved in ${elapsed}s — ${cookies.length} cookies`);
    if (turnstileToken) {
      console.log(`  🔑 Turnstile token included`);
    }

    return { cookies, userAgent, turnstileToken };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️  FlareSolverr unreachable: ${msg}`);
    return null;
  }
}

/**
 * Convert FlareSolverr cookies to the format Playwright's addCookies expects.
 */
export function toPlaywrightCookies(
  fsCookies: FlareSolverrCookie[],
  defaultDomain: string = '.claude.ai',
): Array<{ name: string; value: string; domain: string; path: string }> {
  return fsCookies
    .filter((c) => c.name && c.value)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || defaultDomain,
      path: c.path || '/',
    }));
}
