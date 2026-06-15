import React, { useState, useCallback } from 'react';
import { ScheduleModal } from './ScheduleModal';
import type { ScheduleConfig } from './ScheduleModal';

export const QueueButton: React.FC = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lastStatus, setLastStatus] = useState<string | null>(null);

  const handleSubmit = useCallback(async (config: ScheduleConfig) => {
    try {
      // Send to background script for processing
      const response = await browser.runtime.sendMessage({
        type: 'QUEUE_JOB',
        payload: config,
      });

      if (response?.ok) {
        setLastStatus('✓ Queued');
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

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        title="Queue message for later"
        className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-claude-orange/20 to-claude-orange/10 hover:from-claude-orange/30 hover:to-claude-orange/15 text-claude-orange hover:text-claude-orange/90 transition-all duration-150 border border-claude-orange/30 hover:border-claude-orange/50 shadow-sm hover:shadow-md"
        style={{ marginLeft: '6px', marginRight: '6px', flexShrink: 0 }}
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
          className={`text-xs ml-1 ${lastStatus.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}
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
