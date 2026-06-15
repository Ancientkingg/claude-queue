/**
 * Cloudflare Turnstile CAPTCHA solver using external solving services.
 * Supports 2captcha (default) and Capsolver with automatic provider detection.
 *
 * Flow:
 *  1. Detect Turnstile iframe → extract `sitekey` and `pageurl`
 *  2. Submit task to solving service → receive task ID
 *  3. Poll for solution token (typical solve time: 10-45s)
 *  4. Return token for injection into the page
 *
 * Env vars:
 *  - CAPTCHA_API_KEY     API key for your solving service
 *  - CAPTCHA_SERVICE     "2captcha" (default) or "capsolver"
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface CaptchaSolveResult {
  token: string;
  solvedAt: number;
  elapsedMs: number;
}

interface CreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
}

interface GetResultResponse {
  errorId: number;
  status: 'processing' | 'ready';
  solution?: {
    token?: string;
  };
}

// ─── Configuration ────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.CAPTCHA_API_KEY?.trim();
  if (!key) throw new Error('CAPTCHA_API_KEY env var is not set');
  return key;
}

function getService(): '2captcha' | 'capsolver' {
  const svc = (process.env.CAPTCHA_SERVICE ?? '2captcha').toLowerCase();
  if (svc === 'capsolver') return 'capsolver';
  return '2captcha';
}

// ─── 2captcha API ─────────────────────────────────────────────────────────

async function createTask2captcha(apiKey: string, sitekey: string, pageurl: string): Promise<number> {
  const body: Record<string, string> = {
    key: apiKey,
    method: 'turnstile',
    sitekey,
    pageurl,
    // Cloudflare Turnstile may require a domain-specific user-agent match
    ...(process.env.CAPTCHA_PROXY ? { proxy: process.env.CAPTCHA_PROXY, proxytype: 'HTTP' } : {}),
  };

  const formData = new URLSearchParams(body).toString();

  const res = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'TurnstileTask',
        websiteURL: pageurl,
        websiteKey: sitekey,
      },
    }),
  });

  const data: CreateTaskResponse = await res.json();
  if (data.errorId !== 0) {
    throw new Error(`2captcha createTask failed: ${data.errorDescription ?? data.errorCode}`);
  }
  if (!data.taskId) throw new Error('2captcha returned no taskId');

  console.log(`  🤖 2captcha task created: ${data.taskId}`);
  return data.taskId;
}

async function poll2captcha(apiKey: string, taskId: number, timeoutMs: number): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);

    const res = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const data: GetResultResponse = await res.json();

    if (data.status === 'ready' && data.solution?.token) {
      console.log(`  ✅ 2captcha solved in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return data.solution.token;
    }

    if (data.errorId !== 0) {
      // 2captcha reports status==='processing' with errorId===0; non-zero is a real error
      throw new Error(`2captcha poll error: ${JSON.stringify(data)}`);
    }
  }

  throw new Error(`2captcha task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

// ─── Capsolver API (alternative provider) ──────────────────────────────────

async function createTaskCapsolver(apiKey: string, sitekey: string, pageurl: string): Promise<string> {
  const res = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: pageurl,
        websiteKey: sitekey,
      },
    }),
  });

  const data: any = await res.json();
  if (data.errorId !== 0) throw new Error(`Capsolver createTask failed: ${data.errorDescription}`);
  if (!data.taskId) throw new Error('Capsolver returned no taskId');

  console.log(`  🤖 Capsolver task created: ${data.taskId}`);
  return data.taskId;
}

async function pollCapsolver(apiKey: string, taskId: string, timeoutMs: number): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);

    const res = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const data: any = await res.json();

    if (data.status === 'ready' && data.solution?.token) {
      console.log(`  ✅ Capsolver solved in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return data.solution.token;
    }

    if (data.errorId !== 0) {
      throw new Error(`Capsolver poll error: ${data.errorDescription}`);
    }
  }

  throw new Error(`Capsolver task ${taskId} timed out`);
}

// ─── Public API ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Solve a Cloudflare Turnstile challenge.
 *
 * @param sitekey  - Turnstile sitekey extracted from the iframe src or inline config
 * @param pageurl  - URL of the page where the challenge appeared
 * @param timeoutMs - Max time to wait (default 120s, solving typically takes 10-45s)
 */
export async function solveTurnstile(
  sitekey: string,
  pageurl: string,
  timeoutMs: number = 120_000,
): Promise<CaptchaSolveResult> {
  const apiKey = getApiKey();
  const service = getService();
  const start = Date.now();

  console.log(`  🤖 Solving Turnstile via ${service} (sitekey=${sitekey.slice(0, 8)}...)`);

  let token: string;

  if (service === 'capsolver') {
    const taskId = await createTaskCapsolver(apiKey, sitekey, pageurl);
    token = await pollCapsolver(apiKey, taskId, timeoutMs);
  } else {
    const taskId = await createTask2captcha(apiKey, sitekey, pageurl);
    token = await poll2captcha(apiKey, taskId, timeoutMs);
  }

  const elapsed = Date.now() - start;
  return { token, solvedAt: Date.now(), elapsedMs: elapsed };
}

/**
 * Extract the Turnstile sitekey from the current page.
 * Cloudflare embeds it in the iframe src or as a data-sitekey attribute.
 */
export function extractSitekeyFromSrc(src: string): string | null {
  // iframe src looks like:
  // https://challenges.cloudflare.com/cdn-cgi/challenge-platform/.../turnstile/.../0x4AAAAAAAEoQUm0nOM1ZkZA/...
  const m = src.match(/\/(0x[0-9A-Fa-f]+)\//);
  return m ? m[1] : null;
}
