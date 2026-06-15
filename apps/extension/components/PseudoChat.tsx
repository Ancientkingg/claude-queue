import React, { useEffect, useState } from 'react';
import type { QueueStore } from '@/lib/queue-store';
import { CL } from '@/lib/theme';
import { useQueueJobs } from './queue-hooks';
import { QueuedCard } from './QueuedBubbles';

/**
 * Overlay that simulates a chat window for a message queued into a NEW chat.
 * Opened via the 'cq:open-pseudo' event (detail.id = job id). No input box.
 */
export const PseudoChat: React.FC<{ store: QueueStore }> = ({ store }) => {
  const jobs = useQueueJobs(store);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => setOpenId((e as CustomEvent).detail?.id ?? null);
    const close = () => setOpenId(null);
    window.addEventListener('cq:open-pseudo', open);
    window.addEventListener('cq:close-pseudo', close);
    return () => {
      window.removeEventListener('cq:open-pseudo', open);
      window.removeEventListener('cq:close-pseudo', close);
    };
  }, []);

  if (!openId) return null;
  const job = jobs.find((j) => j.id === openId);
  // The job vanished (canceled or sent) → close the overlay.
  if (!job) { if (openId) setTimeout(() => setOpenId(null), 0); return null; }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999998, background: CL.bg,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', borderBottom: `1px solid ${CL.border}`,
      }}>
        <span style={{ color: CL.text, fontSize: 15, fontWeight: 600 }}>Queued · new chat</span>
        <button onClick={() => setOpenId(null)} style={{
          background: 'none', border: 'none', color: CL.muted, fontSize: 24, cursor: 'pointer', lineHeight: 1,
        }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div style={{ color: CL.muted, fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
            This message hasn't been sent yet — it will start a new chat when it sends.
          </div>
          <QueuedCard job={job} store={store} />
        </div>
      </div>
    </div>
  );
};
