import { describe, it, expect } from 'vitest';
import { parseConversationId } from './conversation';

describe('parseConversationId', () => {
  const id = '019ecc1d-18cc-78c1-8d6d-160f22e61cad';
  it('extracts the uuid from a /chat/ path', () => {
    expect(parseConversationId(`/chat/${id}`)).toBe(id);
    expect(parseConversationId(`/chat/${id}?foo=1`)).toBe(id);
  });
  it('returns null for new-chat and non-chat paths', () => {
    expect(parseConversationId('/new')).toBeNull();
    expect(parseConversationId('/')).toBeNull();
    expect(parseConversationId('/project/abc')).toBeNull();
  });
});
