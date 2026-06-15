import type { Page, BrowserContext } from 'playwright';
import { solveTurnstile, extractSitekeyFromSrc } from './captcha-solver.js';
import { solveViaFlareSolverr, toPlaywrightCookies, destroySession } from './flare-solverr.js';
import { config } from '../config.js';

export interface AutomationResult {
  success: boolean;
  responseText?: string;
  error?: string;
}

export interface AutomationPayload {
  conversationId: string | null;
  modelTarget: string;
  promptText: string;
  thinkingMode: boolean;
  attachmentBuffers: Array<{
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }>;
}

// ─── Human-like interaction utilities ───────────────────────────────────

/** Return a random delay between min and max milliseconds. */
function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

/** Wait for a randomized duration. */
async function humanDelay(min: number, max: number): Promise<void> {
  await new Promise((r) => setTimeout(r, jitter(min, max)));
}

/**
 * Move the mouse to a random position within the element's bounding box,
 * with intermediate steps to simulate human cursor movement, then click.
 */
async function humanClick(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    // Fallback: direct click if bounding box unavailable
    await locator.click();
    return;
  }

  const targetX = box.x + Math.random() * box.width;
  const targetY = box.y + Math.random() * box.height;

  // Move in 3-8 intermediate steps (human-like curve)
  const steps = jitter(3, 8);
  const startX = Math.random() * box.width * 0.5;
  const startY = Math.random() * box.height * 0.5;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = startX + (targetX - startX) * t + (Math.random() - 0.5) * 3;
    const y = startY + (targetY - startY) * t + (Math.random() - 0.5) * 3;
    await page.mouse.move(x, y);
    await humanDelay(10, 30);
  }

  await humanDelay(50, 200);
  await locator.click();
}

/**
 * Type text character by character with human-like inter-key delays.
 * Occasionally introduces and corrects a typo (~3% chance per character).
 */
/**
 * Click into a contenteditable editor and type text character-by-character
 * with human-like inter-key delays.  Starts with a brief "thinking" pause
 * before the first keystroke (a person reads the prompt before typing).
 * Introduces and corrects a typo ~3% of the time per character.
 */
async function humanType(page: Page, locator: ReturnType<Page['locator']>, text: string): Promise<void> {
  await humanClick(page, locator);

  // Brief "thinking" pause — a real person reads what they're about to type
  await humanDelay(200, 800);

  for (let i = 0; i < text.length; i++) {
    // ~3% chance of a typo that gets immediately corrected
    if (Math.random() < 0.03) {
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoChar = String.fromCharCode(text.charCodeAt(i) + offset);
      await page.keyboard.type(typoChar, { delay: jitter(30, 80) });
      await humanDelay(80, 200);
      await page.keyboard.press('Backspace');
      await humanDelay(30, 100);
    }

    await page.keyboard.type(text[i], { delay: jitter(30, 120) });
    // Occasionally pause mid-word (natural rhythm)
    if (text[i] === ' ' && Math.random() < 0.2) {
      await humanDelay(100, 350);
    }
  }
}

/**
 * Scroll the page a small random amount, simulating a human glancing
 * at the page content.  Used on initial page load to look organic.
 */
async function humanScroll(page: Page): Promise<void> {
  const scrollY = await page.evaluate(() => window.scrollY);
  const maxScroll = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);

  if (maxScroll < 100) return; // nothing to scroll

  const target = Math.min(
    maxScroll,
    scrollY + jitter(50, Math.min(300, maxScroll)),
  );

  // Scroll in 2-4 chunks
  const steps = jitter(2, 4);
  const delta = (target - scrollY) / steps;
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(scrollY + delta * i + (Math.random() - 0.5) * 20);
    await page.mouse.wheel(0, y > scrollY ? jitter(80, 200) : jitter(-200, -80));
    scrollY; // referenced above
    await humanDelay(80, 250);
  }
}

// ─── Turnstile challenge handling ──────────────────────────────────────

/**
 * Attempt to detect and solve a Cloudflare Turnstile challenge on the page.
 *
 * Strategy:
 *  1. Wait briefly for the challenge iframe to appear (CF loads it async).
 *  2. Extract the sitekey from the iframe src.
 *  3. Submit to an external solving service (2captcha / Capsolver).
 *  4. Inject the solved token into the Turnstile callback and submit the form.
 *
 * Returns true if the challenge was successfully solved, false otherwise.
 */
async function handleTurnstileChallenge(page: Page): Promise<boolean> {
  try {
    // Wait for the Turnstile iframe to appear (CF loads it after a short JS delay)
    const iframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    const frameCount = await iframe.count();
    if (frameCount === 0) {
      console.log('  ⚠️  Turnstile iframe not found');
      return false;
    }

    const src = (await iframe.getAttribute('src')) ?? '';
    console.log(`  🔎 Turnstile iframe detected: ${src.slice(0, 80)}...`);

    const sitekey = extractSitekeyFromSrc(src);
    if (!sitekey) {
      console.log('  ⚠️  Could not extract sitekey from iframe src');
      return false;
    }

    const pageurl = page.url();
    console.log(`  🔑 Sitekey: ${sitekey}`);

    // Call the external solver
    const result = await solveTurnstile(
      sitekey,
      pageurl,
      config.captchaSolverTimeoutMs,
    );

    console.log(`  ✅ Turnstile solved in ${(result.elapsedMs / 1000).toFixed(1)}s`);

    // Inject the token into the Turnstile callback
    await page.evaluate((token: string) => {
      // Cloudflare Turnstile exposes turnstile.render and the callback
      // is typically registered on window. We inject by calling the
      // global callback with the solved token.
      const w = window as any;

      // Method 1: direct callback if available
      if (typeof w.turnstile?.render === 'function') {
        // Find the Turnstile instance
        const nodes = document.querySelectorAll('.cf-turnstile');
        for (const node of nodes) {
          const id = (node as HTMLElement).dataset['turnstileId'];
          if (id && w.turnstile?.getResponse?.(id) === '') {
            // Inject token via the Turnstile API internal mechanism
            const input = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
            if (input) {
              input.value = token;
              // Dispatch events so CF's JS picks up the change
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Call the data-callback if one is registered on the widget
            const widgetEl = document.querySelector(`[data-turnstile-id="${id}"]`);
            const callbackName = widgetEl?.getAttribute('data-callback');
            if (callbackName && typeof w[callbackName] === 'function') {
              (w[callbackName] as Function)(token);
            }
          }
        }
      }

      // Method 2: set the hidden input and submit the challenge form
      const input = document.querySelector<HTMLInputElement>(
        'input[name="cf-turnstile-response"], #challenge-form input[type="hidden"]',
      );
      if (input) {
        input.value = token;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Method 3: call _cf_chl_opt callback (Cloudflare challenge platform)
      if (typeof w._cf_chl_opt?.cCallback === 'function') {
        w._cf_chl_opt.cCallback(token);
      }

      // Method 4: postMessage to the challenge iframe (some CF configurations)
      const frames = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
      for (const frame of frames) {
        (frame as HTMLIFrameElement).contentWindow?.postMessage({ type: 'cf-turnstile-response', token }, '*');
      }
    }, result.token);

    // Wait for the challenge to resolve after token injection
    await humanDelay(2_000, 4_000);

    // Check if the challenge cleared
    const stillBlocked = await checkForBlock(page);
    if (stillBlocked) {
      console.log(`  ⚠️  Challenge still present after token injection: ${stillBlocked}`);
      return false;
    }

    console.log('  ✅ Turnstile challenge cleared');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️  Turnstile handling error: ${msg}`);
    return false;
  }
}

/**
 * Navigate to a URL with FlareSolverr-based challenge bypass as the primary
 * strategy, falling back to direct navigation + CAPTCHA solving.
 *
 * Flow:
 *  1. Call FlareSolverr to solve any Cloudflare challenge before Playwright
 *     even touches the page. Inject the clearance cookies AND spoof the
 *     User-Agent so Cloudflare's JS fingerprinting sees the same browser.
 *  2. Navigate with Playwright — Cloudflare sees matching UA + cf_clearance
 *     and lets us through without a challenge.
 *  3. If FlareSolverr is unreachable or fails, fall back to direct navigation
 *     with the existing detection → auto-resolve → CAPTCHA solving chain.
 *
 * Returns the FlareSolverr User-Agent if one was used, so the caller can
 * continue to spoof it for late-challenge handling.
 */
async function navigateWithRetry(
  page: Page,
  url: string,
  maxAttempts: number = 3,
): Promise<string | null> {
  const baseDelay = config.retryBaseMs;
  let fsUserAgent: string | null = null;
  let fsSessionBurned = false;

  // ── Primary strategy: FlareSolverr pre-seeding ─────────────────────────
  try {
    console.log('  🦾 Attempting FlareSolverr pre-seed...');
    const fsSolution = await solveViaFlareSolverr(url, 60_000, fsSessionBurned);

    if (fsSolution && fsSolution.cookies.length > 0) {
      // Inject the Cloudflare clearance cookies into the browser context
      const pwCookies = toPlaywrightCookies(fsSolution.cookies);
      await page.context().addCookies(pwCookies);
      console.log(`  🍪 Seeded ${pwCookies.length} FlareSolverr cookies`);

      // ── CRITICAL: Match FlareSolverr's UA at both layers ────────────
      // Cloudflare binds cf_clearance to a specific UA. We must match it:
      //  1. HTTP header level — XHR/fetch carry the real User-Agent header
      //  2. JS level — navigator.userAgent fingerprinting in Cloudflare's JS
      if (fsSolution.userAgent) {
        fsUserAgent = fsSolution.userAgent;
        // Layer 1: Rewrite HTTP User-Agent on EVERY request via route interception.
        // This is the critical fix — without it, SPA API calls carry the wrong UA.
        await page.route('**/*', async (route) => {
          const headers = await route.request().allHeaders();
          headers['user-agent'] = fsUserAgent!;
          await route.continue({ headers });
        });
        // Layer 2: Override navigator.userAgent for JS fingerprinting checks
        await page.addInitScript((ua: string) => {
          Object.defineProperty(navigator, 'userAgent', {
            get: () => ua,
            configurable: true,
          });
        }, fsSolution.userAgent);
        console.log(`  🎭 Matched UA at HTTP header + JS level → FlareSolverr`);
      }

      // Navigate — Cloudflare should see matching UA + clearance cookie
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await humanDelay(800, 1_500);
      console.log(`  📍 Landed on ${page.url()}`);

      const block = await checkForBlock(page);
      if (!block) {
        console.log('  ✅ FlareSolverr bypass successful');
        return fsUserAgent;
      }

      // FlareSolverr cookies were rejected — the session is likely burned.
      // Destroy it so the next attempt gets a fresh browser.
      console.log(`  ⚠️  FlareSolverr bypass incomplete (${block}), destroying burned session`);
      fsSessionBurned = true;
      await destroySession();
    } else {
      console.log('  ⚠️  FlareSolverr returned no cookies, falling back to direct navigation');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠️  FlareSolverr pre-seed failed: ${msg}`);
  }

  // ── Fallback: direct navigation + challenge detection + CAPTCHA solving ──
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(attempt > 1
      ? `  🔄 Retry attempt ${attempt}/${maxAttempts}...`
      : `  📄 Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // claude.ai may bounce through an anti-abuse challenge redirect
    await humanDelay(800, 1_500);
    console.log(`  📍 Landed on ${page.url()}`);

    // Check for a challenge
    const block = await checkForBlock(page);
    if (!block) return null; // clean navigation, done

    console.log(`  🚫 Blocked: ${block} (attempt ${attempt}/${maxAttempts})`);

    if (block === 'SESSION_EXIRED') {
      // Don't retry on expired sessions — no amount of solving will fix this
      throw new Error('SESSION_EXIRED');
    }

    // Try auto-resolve first (non-interactive challenges may pass on their own)
    if (block === 'CHALLENGE_RAISED') {
      console.log('  ⏳ Waiting for challenge to auto-resolve...');
      const autoResolved = await waitForChallengeResolution(
        page,
        config.challengeAutoResolveMs,
      );

      if (autoResolved) {
        console.log('  ✅ Challenge auto-resolved');
        return null;
      }

      // Auto-resolve failed — attempt CAPTCHA solving
      console.log('  🤖 Auto-resolve failed, attempting CAPTCHA solving...');
      const solved = await handleTurnstileChallenge(page);
      if (solved) return null;

      // Solving failed — retry with backoff
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 2000;
        console.log(`  ⏳ Backing off ${(delay / 1000).toFixed(1)}s before retry...`);
        await humanDelay(Math.round(delay), Math.round(delay) + 500);
      }
    }
  }

  throw new Error('CHALLENGE_RAISED');
}

/**
 * Execute a prompt on claude.ai and return the response.
 */
export async function executeClaudePrompt(
  context: BrowserContext,
  payload: AutomationPayload,
): Promise<AutomationResult> {
  const page = await context.newPage();

  try {
    // 1. Navigate to Claude (with challenge detection, CAPTCHA solving, and retry)
    const url = payload.conversationId
      ? `https://claude.ai/chat/${payload.conversationId}`
      : 'https://claude.ai/new';

    let fsUserAgent: string | null = null;
    try {
      fsUserAgent = await navigateWithRetry(page, url, config.maxAttempts);
    } catch (navErr) {
      const msg = navErr instanceof Error ? navErr.message : String(navErr);
      return { success: false, error: msg };
    }

    // Perform a brief human-like scroll to look organic
    await humanScroll(page);

    // 2. Wait for the chat editor to be ready.
    console.log('  ⏳ Waiting for chat editor...');
    try {
      await page.waitForSelector('[contenteditable="true"]', { timeout: 15_000 });
    } catch {
      // Late challenge may have appeared — Cloudflare JS detected a UA/fingerprint
      // mismatch on SPA API calls and issued a JS-redirect challenge (NOT a
      // Turnstile iframe). FlareSolverr can solve this by re-fetching with
      // a fresh browser session.
      const lateBlock = await checkForBlock(page);
      if (lateBlock === 'CHALLENGE_RAISED') {
        console.log('  🤖 Late challenge detected, re-solving via FlareSolverr...');

        // Re-solve with a FRESH FlareSolverr session (current one may be burned)
        const fsRetry = await solveViaFlareSolverr(url, 60_000, true);

        if (fsRetry && fsRetry.cookies.length > 0) {
          // Inject fresh clearance cookies
          const pwCookies = toPlaywrightCookies(fsRetry.cookies);
          await page.context().addCookies(pwCookies);
          console.log(`  🍪 Re-seeded ${pwCookies.length} fresh FlareSolverr cookies`);

          // If we got a new UA, match it at both layers
          if (fsRetry.userAgent) {
            fsUserAgent = fsRetry.userAgent;
            // Clear old routes; install fresh header-rewriting + JS override
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await page.route('**/*', async (route) => {
              const headers = await route.request().allHeaders();
              headers['user-agent'] = fsUserAgent!;
              await route.continue({ headers });
            });
            await page.addInitScript((ua: string) => {
              Object.defineProperty(navigator, 'userAgent', {
                get: () => ua,
                configurable: true,
              });
            }, fsRetry.userAgent);
            console.log(`  🎭 Matched fresh FS UA at HTTP header + JS level`);
          }

          // Reload the page with fresh cookies
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await humanDelay(1_000, 2_000);
          console.log(`  📍 Reloaded: ${page.url()}`);

          const recheck = await checkForBlock(page);
          if (!recheck) {
            console.log('  ✅ Late challenge resolved via FlareSolverr');
            try {
              await page.waitForSelector('[contenteditable="true"]', { timeout: 15_000 });
            } catch {
              return { success: false, error: 'Editor did not appear after FlareSolverr re-solve' };
            }
          } else {
            console.warn(`  ⚠️  Challenge still present after re-solve: ${recheck}`);
            return { success: false, error: 'CHALLENGE_RAISED' };
          }
        } else {
          console.warn('  ⚠️  FlareSolverr re-solve failed');
          return { success: false, error: 'CHALLENGE_RAISED' };
        }
      } else {
        return { success: false, error: lateBlock ?? 'Editor did not appear' };
      }
    }

    // 4. Select model if needed
    await selectModel(page, payload.modelTarget);

    // 5. Toggle thinking mode if needed
    if (payload.thinkingMode) {
      await toggleThinkingMode(page);
    }

    // 6. Upload attachments if any
    for (const attachment of payload.attachmentBuffers) {
      await uploadAttachment(page, attachment);
    }

    // 7. Type the prompt with human-like keystrokes
    console.log('  ✏️  Typing prompt...');
    const editor = page.locator('[contenteditable="true"]').first();
    await humanType(page, editor, payload.promptText);

    // Small pause to let UI settle
    await humanDelay(200, 500);

    // 8. Click send
    console.log('  📤 Sending prompt...');
    await clickSendButton(page);

    // 9. Wait for response to complete
    console.log('  ⏳ Waiting for response...');
    await waitForResponse(page);

    // 10. Simulate reading time — a real person reads the response before
    //    closing the tab.  ~200ms per 1000 chars, capped at 3-8 seconds.
    const readingMs = Math.min(
      8_000,
      Math.max(3_000, Math.round(payload.promptText.length * 0.2)),
    );
    const readPause = jitter(Math.round(readingMs * 0.7), Math.round(readingMs * 1.3));
    console.log(`  📖 Simulating reading time (${(readPause / 1000).toFixed(1)}s)...`);
    await humanDelay(readPause, readPause + 1_000);

    // 11. Extract the response text
    const responseText = await extractResponse(page);
    console.log(
      `  ✅ Response received (${responseText.length} chars)`,
    );

    return { success: true, responseText };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`  ❌ Automation error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Check for Cloudflare challenges or login walls.
 * Returns null if no block is detected, or a string describing the block.
 */
async function checkForBlock(page: Page): Promise<string | null> {
  const currentUrl = page.url();

  // ── URL-based checks ──────────────────────────────────────────────
  // claude.ai redirects automation-suspicious requests to an anti-abuse
  // challenge endpoint or a Cloudflare challenge path.
  if (
    /\/api\/challenge_redirect|\/challenge(?:s)?(?:\/|\?|$)|challenges\.cloudflare\.com/.test(
      currentUrl,
    )
  ) {
    return 'CHALLENGE_RAISED';
  }

  // A redirect to the login/auth page means the restored session expired.
  if (/\/login|\/auth|\/sign-in/.test(currentUrl)) {
    return 'SESSION_EXPIRED';
  }

  // ── DOM-based checks ──────────────────────────────────────────────
  // Cloudflare Turnstile iframe
  const turnstileCount = await page
    .locator('iframe[src*="challenges.cloudflare.com"]')
    .count();
  if (turnstileCount > 0) {
    return 'CHALLENGE_RAISED';
  }

  // Cloudflare challenge form
  const challengeFormCount = await page.locator('#challenge-form').count();
  if (challengeFormCount > 0) {
    return 'CHALLENGE_RAISED';
  }

  // Cloudflare challenge stage (Turnstile widget container)
  const challengeStageCount = await page
    .locator('#challenge-stage, [id*="cf-challenge"]')
    .count();
  if (challengeStageCount > 0) {
    return 'CHALLENGE_RAISED';
  }

  // ── Page title check ──────────────────────────────────────────────
  const title = await page.title().catch(() => '');
  if (
    title.toLowerCase().includes('just a moment') ||
    title.toLowerCase().includes('attention required') ||
    title.toLowerCase().includes('security check')
  ) {
    return 'CHALLENGE_RAISED';
  }

  // ── Page content checks ────────────────────────────────────────────
  try {
    const bodyText = await page
      .locator('body')
      .textContent({ timeout: 3_000 })
      .catch(() => '');
    if (bodyText) {
      const lower = bodyText.toLowerCase();
      if (
        lower.includes('checking your browser before accessing') ||
        lower.includes('verify you are a human') ||
        lower.includes('please complete the security check')
      ) {
        return 'CHALLENGE_RAISED';
      }
    }
  } catch {
    // Ignore text content errors
  }

  // ── Login wall check ──────────────────────────────────────────────
  const loginButtonCount = await page
    .locator('button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign in"), a:has-text("Sign in")')
    .count();
  if (loginButtonCount > 0) {
    return 'SESSION_EXPIRED';
  }

  return null;
}

/**
 * Attempt to wait for a Cloudflare challenge to auto-resolve.
 * Turnstile challenges sometimes pass automatically if the browser
 * fingerprint is convincing enough. Returns true if resolved.
 */
async function waitForChallengeResolution(
  page: Page,
  timeoutMs: number = 20_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const block = await checkForBlock(page);
    if (!block) return true; // challenge resolved
    await humanDelay(1_000, 2_000);
  }
  return false;
}

/**
 * Select the target model from the model dropdown.
 *
 * claude.ai displays human-readable model names ("Claude Sonnet 4.6") in the
 * UI while the API/config uses hyphenated IDs ("claude-sonnet-4-6").  This
 * function maps IDs to display substrings and uses progressive fallbacks:
 *  1. Exact text match on a display name
 *  2. Keyword match (e.g. "Sonnet" from "claude-sonnet-4-6")
 *  3. Keyboard navigation: open dropdown, type first letters, press Enter
 */
async function selectModel(page: Page, modelTarget: string): Promise<void> {
  // Map internal model IDs to words that appear in claude.ai's dropdown text.
  const displayKeyword = getModelDisplayKeyword(modelTarget);

  // ── Find and open the model selector button ─────────────────────────
  const selectorCandidates = [
    'button[aria-label*="model" i]',
    'button[aria-label*="Model" i]',
    'button[data-testid="model-selector"]',
    'button[aria-haspopup="listbox"]',
  ];

  let selectorOpened = false;
  for (const selector of selectorCandidates) {
    const element = page.locator(selector).first();
    try {
      // Use waitFor to check existence with a timeout, then count
      await element.waitFor({ state: 'attached', timeout: 2_000 });
      const count = await element.count();
      if (count > 0) {
        console.log(`  🎯 Opening model selector via "${selector}"`);
        await humanClick(page, element);
        await humanDelay(400, 800);
        selectorOpened = true;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!selectorOpened) {
    console.log('  ℹ️  Model selector not found, using default model');
    return;
  }

  // ── Try to click the matching option ─────────────────────────────────
  // Build selectors that match exact model name and/or the display keyword.
  const patterns = [
    // Exact match on the display name or hyphenated ID
    modelTarget,
    displayKeyword,
    // Common display-name formats claude.ai uses
    `Claude ${displayKeyword}`,
  ];

  for (const pattern of patterns) {
    const textSelectors = [
      `[role="option"]:has-text("${pattern}")`,
      `div:has-text("${pattern}"):not([role="tab"])`,
      `li:has-text("${pattern}")`,
      `[role="menuitem"]:has-text("${pattern}")`,
      // Sometimes claude.ai uses a bare clickable span
      `span:has-text("${pattern}")`,
    ];

    for (const sel of textSelectors) {
      const option = page.locator(sel).first();
      try {
        // Use waitFor to check existence with a timeout, then count
        await option.waitFor({ state: 'attached', timeout: 1_500 });
        const optCount = await option.count();
        if (optCount > 0) {
          console.log(`  🎯 Matched model option via "${sel}"`);
          await humanClick(page, option);
          await humanDelay(200, 400);
          return;
        }
      } catch { /* keep trying */ }
    }
  }

  // ── Fallback: keyboard search ───────────────────────────────────────
  // Type the keyword character by character to filter the open dropdown,
  // then press Enter to select the top match.
  console.log(`  ⌨️  Trying keyboard navigation for "${displayKeyword}"...`);
  for (const ch of displayKeyword) {
    await page.keyboard.type(ch, { delay: jitter(30, 80) });
  }
  await humanDelay(300, 600);
  await page.keyboard.press('Enter');
  await humanDelay(200, 400);
  console.log(`  ✅ Model selected via keyboard (keyword: "${displayKeyword}")`);
}

/**
 * Extract a human-readable keyword from a model ID for matching against
 * claude.ai's dropdown labels.
 */
function getModelDisplayKeyword(modelId: string): string {
  const mapping: Record<string, string> = {
    'claude-opus-4-8':     'Opus',
    'claude-sonnet-4-6':   'Sonnet',
    'claude-haiku-4-5-20251001': 'Haiku',
    // Fable has been made unavailable by Anthropic — excluded
    'claude-opus-4-7':     'Opus',
    'claude-sonnet-4-5':   'Sonnet',
    'claude-haiku-4-5':    'Haiku',
  };
  if (mapping[modelId]) return mapping[modelId];

  // Fallback: extract the model family from the ID
  const lower = modelId.toLowerCase();
  if (lower.includes('opus'))   return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku'))  return 'Haiku';
  // Fable removed — Anthropic discontinued it

  // Last resort: return the raw ID
  return modelId;
}

/**
 * Toggle the thinking/extended thinking mode on if not already active.
 */
async function toggleThinkingMode(page: Page): Promise<void> {
  const toggleSelectors = [
    '[data-testid="thinking-toggle"]',
    'button[aria-label*="thinking" i]',
    'button[aria-label*="extended" i]',
  ];

  for (const selector of toggleSelectors) {
    const toggle = page.locator(selector).first();
    const count = await toggle.count();
    if (count > 0) {
      const isActive = await toggle.getAttribute('aria-checked');
      if (isActive !== 'true') {
        console.log('  🧠 Enabling thinking mode...');
        await humanClick(page, toggle);
        await humanDelay(200, 400);
      } else {
        console.log('  🧠 Thinking mode already active');
      }
      return;
    }
  }

  console.log('  ⚠️  Thinking mode toggle not found');
}

/**
 * Upload a single attachment file.
 */
async function uploadAttachment(
  page: Page,
  attachment: { buffer: Buffer; fileName: string; mimeType: string },
): Promise<void> {
  console.log(`  📎 Uploading attachment: ${attachment.fileName}`);

  // Try to find a visible file input
  const fileInput = page.locator('input[type="file"]').first();
  const inputCount = await fileInput.count();

  if (inputCount > 0) {
    await fileInput.setInputFiles({
      name: attachment.fileName,
      mimeType: attachment.mimeType,
      buffer: attachment.buffer,
    });
  } else {
    // If no file input is visible, try to trigger one via the attach button
    const attachButton = page
      .locator(
        'button[aria-label*="attach" i], button[aria-label*="upload" i], button[aria-label*="file" i]',
      )
      .first();
    const buttonCount = await attachButton.count();
    if (buttonCount > 0) {
      // Set up file chooser listener before clicking
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5_000 }),
        humanClick(page, attachButton),
      ]);
      await fileChooser.setFiles({
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        buffer: attachment.buffer,
      });
    } else {
      console.log('  ⚠️  Could not find file upload mechanism');
      return;
    }
  }

  // Wait for the upload to be processed by the UI
  await humanDelay(1_000, 2_000);
  console.log(`  ✅ Attachment uploaded: ${attachment.fileName}`);
}

/**
 * Click the send/submit button.
 */
async function clickSendButton(page: Page): Promise<void> {
  const sendSelectors = [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="send" i]',
    'button[data-testid="send-button"]',
    'button[type="submit"]',
  ];

  for (const selector of sendSelectors) {
    const button = page.locator(selector).first();
    const count = await button.count();
    if (count > 0) {
      const isEnabled = await button.isEnabled();
      if (isEnabled) {
        await humanClick(page, button);
        return;
      }
    }
  }

  // Fallback: try pressing Enter
  console.log('  ⚠️  Send button not found, trying Enter key');
  await page.keyboard.press('Enter');
}

/**
 * Wait for Claude to finish generating its response.
 *
 * Strategy (tried in order):
 * 1. Watch for a "Stop" button to appear (generation started) then disappear
 *    (generation finished). This is the most reliable signal when available.
 * 2. Fall back to polling: watch for new DOM content that stops changing
 *    for a cooldown window, signalling the stream has finished.
 */
async function waitForResponse(page: Page): Promise<void> {
  const stopSelectors = [
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
    'button[aria-label*="stop" i]',
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generation-button"]',
    // claude.ai sometimes uses an icon-only button with a title attribute
    'button[title*="Stop" i]',
    'button[title*="stop" i]',
  ];

  // ── Phase 1: race all stop-button selectors in parallel ──
  // Spawn a promise per selector; each polls for 2 s.  Whichever matches
  // first wins.  If none match within 2 s we fall through to content
  // polling — a real stop button always appears within ~1 s of sending.
  const STOP_POLL_MS = 2_000;

  const racePromises = stopSelectors.map((sel) =>
    page.waitForSelector(sel, { timeout: STOP_POLL_MS }).then(() => sel).catch(() => null),
  );
  racePromises.push(
    new Promise<null>((r) => setTimeout(() => r(null), STOP_POLL_MS)),
  );

  const winner = await Promise.race(racePromises);

  if (winner) {
    console.log(`  ⏹️  Stop button detected via "${winner}"`);
    // Wait for generation to finish (stop button disappears)
    await page.waitForSelector(winner, {
      state: 'hidden',
      timeout: 300_000,
    });
    console.log('  ⏹️  Stop button disappeared — generation complete');
  } else {
    // ── Phase 2: polling fallback ───────────────────────────────────
    // No stop button appeared. Instead, poll the DOM for new assistant
    // message content and wait until it stabilises.
    console.log(
      '  ℹ️  Stop button not detected, using content-polling fallback...',
    );

    const start = Date.now();
    const maxWait = 300_000; // 5 min ceiling
    const stableWindow = 5_000; // content must be unchanged for this long
    let lastContent = '';
    let lastChange = Date.now();

    // Wait for *some* content first (up to 30s)
    while (Date.now() - start < 30_000) {
      const content = await extractRawAssistantContent(page);
      if (content.length > 0) {
        lastContent = content;
        lastChange = Date.now();
        break;
      }
      await humanDelay(1_500, 2_500);
    }

    if (!lastContent) {
      console.log('  ⚠️  No response content appeared after 30s — giving up');
      return;
    }

    // Now poll until content stops changing for the stable window
    while (Date.now() - start < maxWait) {
      await humanDelay(2_000, 4_000);
      const content = await extractRawAssistantContent(page);

      if (content.length > 0 && content !== lastContent) {
        lastContent = content;
        lastChange = Date.now();
      }

      if (Date.now() - lastChange >= stableWindow) {
        console.log(
          `  ✅ Response stabilised after ${Math.round((Date.now() - start) / 1000)}s`,
        );
        break;
      }
    }
  }

  // Extra settle time for DOM updates
  await humanDelay(800, 1_200);
}

/**
 * Extract raw text from any visible assistant message element.
 * Used by the polling fallback in waitForResponse — returns whatever
 * content exists right now, without waiting.
 */
async function extractRawAssistantContent(page: Page): Promise<string> {
  // Try the same selectors used by extractResponse, just inline
  const selectors = [
    '[data-is-streaming="false"]',
    '[data-testid="assistant-message"]',
    '[class*="assistant"]',
    '[data-role="assistant"]',
    '[class*="message"]',
  ];

  for (const sel of selectors) {
    const el = page.locator(sel).last();
    try {
      const text = await el.textContent({ timeout: 2_000 });
      if (text && text.trim().length > 0) return text.trim();
    } catch {
      // keep trying
    }
  }

  return '';
}

/**
 * Extract the assistant's response text from the page.
 */
async function extractResponse(page: Page): Promise<string> {
  // Strategy 1: Look for streaming-complete markers — these carry the
  // final, fully-streamed response content.
  const streamingDone = page.locator('[data-is-streaming="false"]').last();
  try {
    const text = await streamingDone.textContent({ timeout: 3_000 });
    if (text && text.trim().length > 0) {
      return text.trim();
    }
  } catch {
    // Not found or timeout
  }

  // Strategy 2: Look for assistant message containers (by testid first,
  // then class-based fallbacks). Use last() to get the most recent reply.
  const messageSelectors = [
    '[data-testid="assistant-message"]',
    '[data-role="assistant"]',
    '[class*="assistant"]',
    '[class*="message"]',
  ];

  for (const selector of messageSelectors) {
    const element = page.locator(selector).last();
    try {
      const text = await element.textContent({ timeout: 3_000 });
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    } catch {
      // continue
    }
  }

  // Strategy 3: Walk backwards through all message-like elements,
  // skipping any that contain the user's prompt (the Send button
  // click should leave the prompt visible in a user-bubble).
  const allMessages = page.locator(
    '[class*="message"], [data-testid*="message"], [class*="prose"]',
  );
  const count = await allMessages.count();
  for (let i = count - 1; i >= 0; i--) {
    try {
      const text = await allMessages.nth(i).textContent({ timeout: 2_000 });
      if (text && text.trim().length > 10) {
        return text.trim();
      }
    } catch {
      // skip broken elements
    }
  }

  return '[No response text could be extracted]';
}
