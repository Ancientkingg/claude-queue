import type { Page, BrowserContext } from 'playwright';

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

/**
 * Execute a prompt on claude.ai and return the response.
 */
export async function executeClaudePrompt(
  context: BrowserContext,
  payload: AutomationPayload,
): Promise<AutomationResult> {
  const page = await context.newPage();

  try {
    // 1. Navigate to Claude
    const url = payload.conversationId
      ? `https://claude.ai/chat/${payload.conversationId}`
      : 'https://claude.ai/new';

    console.log(`  📄 Navigating to ${url}`);
    // Use 'domcontentloaded' rather than 'networkidle': claude.ai holds long-lived
    // SSE/WebSocket connections open, so the network never goes idle and 'networkidle'
    // would reliably hit the timeout. Readiness is confirmed below via the editor selector.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // 2. Check for Cloudflare challenge or login wall
    const blockResult = await checkForBlock(page);
    if (blockResult) {
      console.log(`  🚫 Blocked: ${blockResult}`);
      return { success: false, error: blockResult };
    }

    // 3. Wait for the chat editor to be ready
    console.log('  ⏳ Waiting for chat editor...');
    await page.waitForSelector('[contenteditable="true"]', { timeout: 15_000 });

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

    // 7. Type the prompt
    console.log('  ✏️  Typing prompt...');
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await editor.fill(payload.promptText);

    // Small pause to let UI settle
    await page.waitForTimeout(300);

    // 8. Click send
    console.log('  📤 Sending prompt...');
    await clickSendButton(page);

    // 9. Wait for response to complete
    console.log('  ⏳ Waiting for response...');
    await waitForResponse(page);

    // 10. Extract the response text
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
  // Check for Cloudflare Turnstile challenge
  const turnstileCount = await page
    .locator('iframe[src*="challenges.cloudflare.com"]')
    .count();
  if (turnstileCount > 0) {
    return 'CHALLENGE_RAISED';
  }

  // Check for "Just a moment" Cloudflare interstitial
  const title = await page.title();
  if (title.toLowerCase().includes('just a moment')) {
    return 'CHALLENGE_RAISED';
  }

  // Check for login page
  const loginButtonCount = await page
    .locator('button:has-text("Log in"), a:has-text("Log in")')
    .count();
  if (loginButtonCount > 0) {
    return 'SESSION_EXPIRED';
  }

  return null;
}

/**
 * Select the target model from the model dropdown.
 */
async function selectModel(page: Page, modelTarget: string): Promise<void> {
  // Try multiple possible selectors for the model selector
  const selectorCandidates = [
    '[data-testid="model-selector"]',
    'button[aria-label*="model" i]',
    'button[aria-haspopup="listbox"]',
  ];

  for (const selector of selectorCandidates) {
    const element = page.locator(selector).first();
    const count = await element.count();
    if (count > 0) {
      console.log(`  🎯 Selecting model: ${modelTarget}`);
      await element.click();
      await page.waitForTimeout(500);

      // Try clicking the target model option
      const optionSelectors = [
        `[data-testid="model-option-${modelTarget}"]`,
        `[data-value="${modelTarget}"]`,
        `li:has-text("${modelTarget}")`,
        `div[role="option"]:has-text("${modelTarget}")`,
      ];

      for (const optionSelector of optionSelectors) {
        const option = page.locator(optionSelector).first();
        const optionCount = await option.count();
        if (optionCount > 0) {
          await option.click();
          await page.waitForTimeout(300);
          return;
        }
      }

      // If no option matched, click elsewhere to close the dropdown
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      console.log(
        `  ⚠️  Model option "${modelTarget}" not found in dropdown`,
      );
      return;
    }
  }

  // Model selector not found — may not be visible on this page
  console.log('  ℹ️  Model selector not found, using default model');
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
        await toggle.click();
        await page.waitForTimeout(300);
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
        attachButton.click(),
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
  await page.waitForTimeout(1_500);
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
        await button.click();
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
 * We detect this by waiting for a "stop" button to appear (generation started)
 * and then waiting for it to disappear (generation finished).
 */
async function waitForResponse(page: Page): Promise<void> {
  const stopSelectors = [
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop response"]',
    'button[aria-label*="stop" i]',
    'button[data-testid="stop-button"]',
  ];

  // Wait for generation to start (stop button appears)
  // This may not appear for very fast responses, so we use a short timeout
  let stopSelector: string | null = null;
  for (const selector of stopSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 10_000 });
      stopSelector = selector;
      break;
    } catch {
      // Try next selector
    }
  }

  if (stopSelector) {
    // Wait for generation to finish (stop button disappears)
    // Allow up to 5 minutes for long responses
    await page.waitForSelector(stopSelector, {
      state: 'hidden',
      timeout: 300_000,
    });
  } else {
    // If no stop button appeared, wait a bit and look for response content
    console.log(
      '  ℹ️  Stop button not detected, waiting for response content...',
    );
    await page.waitForTimeout(5_000);
  }

  // Extra settle time for DOM updates
  await page.waitForTimeout(1_000);
}

/**
 * Extract the assistant's response text from the page.
 */
async function extractResponse(page: Page): Promise<string> {
  // Try multiple strategies to extract the response

  // Strategy 1: Look for streaming-complete markers
  const streamingDone = page.locator('[data-is-streaming="false"]').last();
  const streamingCount = await streamingDone.count();
  if (streamingCount > 0) {
    const text = await streamingDone.textContent();
    if (text && text.trim().length > 0) {
      return text.trim();
    }
  }

  // Strategy 2: Look for assistant message containers
  const messageSelectors = [
    '[data-testid="assistant-message"]:last-of-type',
    '[class*="assistant"]:last-of-type',
    '[data-role="assistant"]:last-of-type',
  ];

  for (const selector of messageSelectors) {
    const element = page.locator(selector).last();
    const count = await element.count();
    if (count > 0) {
      const text = await element.textContent();
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  // Strategy 3: Get all message-like elements and take the last one
  // that doesn't contain our prompt text
  const allMessages = page.locator(
    '[class*="message"], [data-testid*="message"]',
  );
  const messageCount = await allMessages.count();
  if (messageCount > 0) {
    const lastMessage = allMessages.last();
    const text = await lastMessage.textContent();
    if (text && text.trim().length > 0) {
      return text.trim();
    }
  }

  return '[No response text could be extracted]';
}
