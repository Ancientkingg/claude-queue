import React, { useState, useCallback } from 'react';
import { ScheduleModal } from './ScheduleModal';
import type { ScheduleConfig } from './ScheduleModal';
import type { QueuedJob } from '@/lib/queue-store';
import { parseConversationId } from '@/lib/conversation';
import { useThemeColors } from './queue-hooks';

export const QueueButton: React.FC<{ onQueued?: (job: QueuedJob) => void }> = ({ onQueued }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const CL = useThemeColors();

  const handleSubmit = useCallback(async (config: ScheduleConfig) => {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'QUEUE_JOB',
        payload: config,
      });

      if (response?.ok) {
        setLastStatus('✓ Queued');
        // Clear the text input so the user doesn't have to manually
        // delete a prompt they've already queued.
        const editable = document.querySelector<HTMLElement>('[contenteditable="true"]');
        if (editable) {
          editable.textContent = '';
          editable.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        if (response.jobId && response.scheduledAt) {
          onQueued?.({
            id: response.jobId,
            conversationId: parseConversationId(location.pathname),
            promptText: config.promptText,
            modelTarget: config.modelTarget,
            scheduledFor: response.scheduledAt,
            status: 'PENDING',
          });
        }
        setTimeout(() => setLastStatus(null), 3000);
      } else {
        setLastStatus(`✗ ${response?.error ?? 'Failed'}`);
        setTimeout(() => setLastStatus(null), 5000);
      }
    } catch (err) {
      setLastStatus('✗ Error');
      setTimeout(() => setLastStatus(null), 5000);
    }

    setIsModalOpen(false);
  }, []);

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: CL.orange,
    cursor: 'pointer',
    marginLeft: 2,
    marginRight: 2,
    flexShrink: 0,
    padding: 0,
    transition: 'background 0.15s, color 0.15s',
    outline: 'none',
  };

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        title="Queue message for later"
        style={btnStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(218, 119, 86, 0.15)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>

      {lastStatus && (
        <span
          style={{
            fontSize: 12,
            marginLeft: 4,
            color: lastStatus.startsWith('✓') ? '#4ade80' : '#f87171',
          }}
        >
          {lastStatus}
        </span>
      )}

      <ScheduleModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleSubmit}
      />
    </>
  );
};
