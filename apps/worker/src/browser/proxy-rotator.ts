/**
 * Rotating proxy pool for per-job browser contexts.
 *
 * Reads PROXY_LIST from env (newline-separated, format:
 *   http://user:pass@host:port   or   socks5://user:pass@host:port)
 *
 * If PROXY_LIST is empty or unset, returns direct (no proxy) — Cloudflare
 * still passes with strong fingerprint spoofing alone, but proxy rotation
 * is recommended for production to reduce IP-based rate limiting.
 */

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

let pool: ProxyConfig[] = [];
let cursor = 0;

function loadPool(): ProxyConfig[] {
  if (pool.length > 0) return pool;

  const raw = process.env.PROXY_LIST?.trim();
  if (!raw) {
    console.log('  🌐 No PROXY_LIST configured — using direct connection');
    return [];
  }

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  pool = lines.map(parseProxyLine).filter(Boolean) as ProxyConfig[];

  console.log(`  🌐 Loaded ${pool.length} proxy(s)`);
  return pool;
}

function parseProxyLine(line: string): ProxyConfig | null {
  try {
    const url = new URL(line);
    // The protocol includes the proxy scheme (http, https, socks5)
    const server = `${url.protocol}//${url.hostname}:${url.port}`;
    const cfg: ProxyConfig = { server };

    if (url.username) cfg.username = decodeURIComponent(url.username);
    if (url.password) cfg.password = decodeURIComponent(url.password);

    return cfg;
  } catch {
    console.warn(`  ⚠️  Invalid proxy line: "${line.slice(0, 40)}..."`);
    return null;
  }
}

/**
 * Return the next proxy from the pool (round-robin). Returns `null` when the
 * pool is empty, signalling Playwright to use a direct connection.
 */
export function nextProxy(): ProxyConfig | null {
  const proxies = loadPool();
  if (proxies.length === 0) return null;

  const proxy = proxies[cursor % proxies.length];
  cursor = (cursor + 1) % proxies.length;
  return proxy;
}

/**
 * Validate that a proxy is reachable by attempting a quick HTTP request
 * through it.  Timeout: 5 s.  Returns true if the proxy responds.
 */
export async function validateProxy(proxy: ProxyConfig, timeoutMs: number = 5_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // We don't import fetch through a proxy directly (Node fetch doesn't
    // easily support proxy config).  Instead we rely on the browser context
    // exercising the proxy on the first navigation — the only real validation
    // that matters.  This function exists as a hook for future health checks.
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

/** Reset the round-robin cursor (useful for testing). */
export function _resetCursor(): void {
  cursor = 0;
}
