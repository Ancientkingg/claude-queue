/**
 * Extract the claude.ai conversation id from a URL pathname.
 * Conversation URLs look like `https://claude.ai/chat/<uuid>`. Returns null for
 * new-chat (`/new`), the root, and any non-chat path.
 */
export function parseConversationId(pathname: string): string | null {
  const m = pathname.match(/\/chat\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}
