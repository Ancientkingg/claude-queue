import React, { useState, useCallback } from 'react';
import { ScheduleModal } from './ScheduleModal';
import type { ScheduleConfig } from './ScheduleModal';

export const QueueButton: React.FC = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [lastStatus, setLastStatus] = useState<string | null>(null);

  const handleSubmit = useCallback(async (config: ScheduleConfig) => {
    try {
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

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 12,
    border: '1px solid rgba(218, 119, 86, 0.3)',
    background: 'rgba(218, 119, 86, 0.12)',
    color: '#da7756',
    cursor: 'pointer',
    marginLeft: 6,
    marginRight: 6,
    flexShrink: 0,
    padding: 0,
    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
    outline: 'none',
  };

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        title="Queue message for later"
        style={btnStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(218, 119, 86, 0.22)';
          e.currentTarget.style.borderColor = 'rgba(218, 119, 86, 0.5)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(218, 119, 86, 0.12)';
          e.currentTarget.style.borderColor = 'rgba(218, 119, 86, 0.3)';
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
