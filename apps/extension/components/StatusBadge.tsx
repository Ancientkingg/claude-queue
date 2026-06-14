import React from 'react';

interface StatusBadgeProps {
  status: 'connected' | 'disconnected' | 'synced' | 'error';
  label?: string;
}

const statusStyles: Record<StatusBadgeProps['status'], string> = {
  connected: 'bg-green-500/20 text-green-400 border-green-500/30',
  synced: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  disconnected: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const statusDots: Record<StatusBadgeProps['status'], string> = {
  connected: 'bg-green-400',
  synced: 'bg-blue-400',
  disconnected: 'bg-gray-400',
  error: 'bg-red-400',
};

const defaultLabels: Record<StatusBadgeProps['status'], string> = {
  connected: 'Connected',
  synced: 'Account Synced',
  disconnected: 'Disconnected',
  error: 'Error',
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  label,
}) => {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${statusStyles[status]}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${statusDots[status]} ${status === 'connected' || status === 'synced' ? 'animate-pulse' : ''}`}
      />
      {label ?? defaultLabels[status]}
    </span>
  );
};
