import React from 'react';
import type { QueueStore, QueuedJob } from '@/lib/queue-store';
import { useQueueJobs, useThemeColors } from './queue-hooks';

interface Entry {
  key: string;
  label: string;
  count: number;
  conversationId: string | null; // null = new-chat pseudo entry
  newChatJobId?: string;          // set for new-chat entries
}

/** Reuse claude's own sidebar title for an existing chat, else a prompt preview. */
function titleForConversation(conversationId: string, fallback: string): string {
  const link = document.querySelector(`a[href$="/chat/${conversationId}"]`);
  const text = link?.textContent?.trim();
  return text && text.length > 0 ? text : fallback;
}

function buildEntries(jobs: QueuedJob[]): Entry[] {
  const byConversation = new Map<string, QueuedJob[]>();
  const newChats: QueuedJob[] = [];
  for (const j of jobs) {
    if (j.conversationId) {
      const arr = byConversation.get(j.conversationId) ?? [];
      arr.push(j);
      byConversation.set(j.conversationId, arr);
    } else {
      newChats.push(j);
    }
  }
  const entries: Entry[] = [];
  for (const [cid, arr] of byConversation) {
    const preview = arr[0].promptText.slice(0, 32);
    entries.push({ key: cid, label: titleForConversation(cid, preview), count: arr.length, conversationId: cid });
  }
  for (const j of newChats) {
    entries.push({ key: j.id, label: j.promptText.slice(0, 32) || 'New chat', count: 1, conversationId: null, newChatJobId: j.id });
  }
  return entries;
}

export const QueuedSidebar: React.FC<{ store: QueueStore }> = ({ store }) => {
  const jobs = useQueueJobs(store);
  const CL = useThemeColors();
  if (jobs.length === 0) return null;
  const entries = buildEntries(jobs);

  const onClick = (e: Entry) => {
    if (e.conversationId) {
      // Navigate via the SPA's own routing so the extension context survives.
      // Find an existing <a> link for this chat in the sidebar and click it —
      // claude.ai's SPA intercepts <a> clicks and routes without a full reload.
      const link = document.querySelector(`a[href$="/chat/${e.conversationId}"]`) as HTMLAnchorElement | null;
      if (link) {
        link.click();
      } else {
        // Chat not in the sidebar yet — push state and let claude.ai's router
        // pick it up via the popstate listener we dispatch.
        history.pushState(null, '', `/chat/${e.conversationId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
        // Also fire our own nav event so hooks/anchors update.
        window.dispatchEvent(new CustomEvent('cq:nav'));
      }
    } else if (e.newChatJobId) {
      window.dispatchEvent(new CustomEvent('cq:open-pseudo', { detail: { id: e.newChatJobId } }));
    }
  };

  return (
    <div style={{ padding: '8px 8px 4px' }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
        color: CL.muted, padding: '4px 8px',
      }}>
        Queued ({jobs.length})
      </div>
      {entries.map((e) => (
        <button key={e.key} onClick={() => onClick(e)} title={e.label} style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer', color: CL.text,
          padding: '6px 8px', borderRadius: 8, fontSize: 13,
        }}
          onMouseEnter={(ev) => { ev.currentTarget.style.background = CL.surface; }}
          onMouseLeave={(ev) => { ev.currentTarget.style.background = 'none'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={CL.orange} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
          {e.count > 1 && <span style={{ fontSize: 11, color: CL.muted }}>{e.count}</span>}
        </button>
      ))}
    </div>
  );
};
