import React, { useState } from 'react';
import type { QueueStore, QueuedJob } from '@/lib/queue-store';
import { CL } from '@/lib/theme';
import { useQueueJobs, useLocationPath, formatSendTime } from './queue-hooks';
import { parseConversationId } from '@/lib/conversation';

/** A single queued message rendered like a sent user bubble + a footer menu. */
export const QueuedCard: React.FC<{ job: QueuedJob; store: QueueStore }> = ({ job, store }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await browser.runtime.sendMessage({ type: 'CANCEL_JOB', payload: { id: job.id } });
      if (res?.ok) {
        store.remove(job.id);
      } else {
        setErr(res?.status === 409 ? 'Already sending' : 'Cancel failed');
        void store.refresh();
      }
    } catch {
      setErr('Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', margin: '12px 0' }}>
      <div style={{
        maxWidth: '75%', background: CL.surface, color: CL.text, borderRadius: 14,
        padding: '10px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        border: `1px solid ${CL.border}`,
      }}>
        {job.promptText}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 5,
        fontSize: 12, color: CL.muted,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: CL.orange }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          Sends ≈ {formatSendTime(job.scheduledFor)}
        </span>
        <button onClick={cancel} disabled={busy} style={{
          background: 'none', border: 'none', color: busy ? CL.muted : '#f87171',
          cursor: busy ? 'default' : 'pointer', fontSize: 12, padding: 0,
        }}>{busy ? 'Canceling…' : 'Cancel'}</button>
        {err && <span style={{ color: '#f87171' }}>{err}</span>}
      </div>
    </div>
  );
};

/** Renders all queued cards for the currently-open conversation. */
export const QueuedBubbles: React.FC<{ store: QueueStore }> = ({ store }) => {
  const jobs = useQueueJobs(store);
  const path = useLocationPath();
  const conversationId = parseConversationId(path);
  const mine = jobs.filter((j) => j.conversationId === conversationId);
  if (mine.length === 0) return null;
  return (
    <div style={{ width: '100%', maxWidth: 760, margin: '0 auto', padding: '0 16px' }}>
      {mine.map((j) => <QueuedCard key={j.id} job={j} store={store} />)}
    </div>
  );
};
