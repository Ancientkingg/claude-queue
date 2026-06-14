import React, { useState, useCallback, useEffect } from 'react';

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: ScheduleConfig) => void;
}

export interface ScheduleConfig {
  promptText: string;
  modelTarget: string;
  thinkingMode: boolean;
  scheduledAt?: string; // ISO 8601
  delaySeconds?: number;
}

const DELAY_OPTIONS = [
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
  { label: '30 min', seconds: 1800 },
  { label: '1 hour', seconds: 3600 },
  { label: '2 hours', seconds: 7200 },
  { label: 'Custom', seconds: -1 },
] as const;

const MODEL_SUGGESTIONS = [
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-3-5-haiku-20241022',
] as const;

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
}) => {
  const [mode, setMode] = useState<'delay' | 'absolute'>('delay');
  const [selectedDelay, setSelectedDelay] = useState<number>(300);
  const [customDelayMinutes, setCustomDelayMinutes] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [modelTarget, setModelTarget] = useState(MODEL_SUGGESTIONS[0]);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setMode('delay');
      setSelectedDelay(300);
      setCustomDelayMinutes('');
      setScheduledAt('');
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const extractPromptText = useCallback((): string => {
    // Try to find the contenteditable area on claude.ai
    const editable = document.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (editable) {
      return editable.textContent?.trim() ?? '';
    }

    // Fallback: textarea
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder]',
    );
    if (textarea) {
      return textarea.value.trim();
    }

    return '';
  }, []);

  const handleSubmit = useCallback(async () => {
    const promptText = extractPromptText();
    if (!promptText) {
      alert('Please type a prompt in the Claude chat input first.');
      return;
    }

    setIsSubmitting(true);

    const config: ScheduleConfig = {
      promptText,
      modelTarget,
      thinkingMode,
    };

    if (mode === 'absolute' && scheduledAt) {
      config.scheduledAt = new Date(scheduledAt).toISOString();
    } else if (mode === 'delay') {
      const delay =
        selectedDelay === -1
          ? (parseInt(customDelayMinutes, 10) || 5) * 60
          : selectedDelay;
      config.delaySeconds = delay;
    }

    onSubmit(config);
    setIsSubmitting(false);
  }, [
    extractPromptText,
    modelTarget,
    thinkingMode,
    mode,
    scheduledAt,
    selectedDelay,
    customDelayMinutes,
    onSubmit,
  ]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-claude-bg border border-claude-border rounded-xl shadow-2xl w-[400px] max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-claude-border">
          <h2 className="text-lg font-semibold text-claude-text">
            Queue Message
          </h2>
          <button
            onClick={onClose}
            className="text-claude-text-muted hover:text-claude-text transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Schedule Mode Toggle */}
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Schedule Type
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setMode('delay')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === 'delay'
                    ? 'bg-claude-orange text-white'
                    : 'bg-claude-surface text-claude-text-muted hover:text-claude-text'
                }`}
              >
                Delay
              </button>
              <button
                onClick={() => setMode('absolute')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === 'absolute'
                    ? 'bg-claude-orange text-white'
                    : 'bg-claude-surface text-claude-text-muted hover:text-claude-text'
                }`}
              >
                Send At
              </button>
            </div>
          </div>

          {/* Delay Options */}
          {mode === 'delay' && (
            <div>
              <label className="block text-sm font-medium text-claude-text mb-2">
                Delay
              </label>
              <div className="grid grid-cols-3 gap-2">
                {DELAY_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => setSelectedDelay(opt.seconds)}
                    className={`px-3 py-2 rounded-lg text-sm transition-colors ${
                      selectedDelay === opt.seconds
                        ? 'bg-claude-orange text-white'
                        : 'bg-claude-surface text-claude-text-muted hover:text-claude-text border border-claude-border'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {selectedDelay === -1 && (
                <input
                  type="number"
                  min="1"
                  placeholder="Minutes..."
                  value={customDelayMinutes}
                  onChange={(e) => setCustomDelayMinutes(e.target.value)}
                  className="mt-2 w-full px-3 py-2 bg-claude-surface border border-claude-border rounded-lg text-claude-text text-sm focus:outline-none focus:border-claude-orange"
                />
              )}
            </div>
          )}

          {/* Absolute Time */}
          {mode === 'absolute' && (
            <div>
              <label className="block text-sm font-medium text-claude-text mb-2">
                Send At
              </label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full px-3 py-2 bg-claude-surface border border-claude-border rounded-lg text-claude-text text-sm focus:outline-none focus:border-claude-orange"
              />
            </div>
          )}

          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Model
            </label>
            <select
              value={modelTarget}
              onChange={(e) => setModelTarget(e.target.value as any)}
              className="w-full px-3 py-2 bg-claude-surface border border-claude-border rounded-lg text-claude-text text-sm focus:outline-none focus:border-claude-orange"
            >
              {MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Thinking Mode */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-claude-text">
              Extended Thinking
            </label>
            <button
              onClick={() => setThinkingMode(!thinkingMode)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                thinkingMode ? 'bg-claude-orange' : 'bg-claude-surface'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  thinkingMode ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-claude-border">
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="w-full px-4 py-2.5 bg-claude-orange hover:bg-claude-orange/90 disabled:opacity-50 text-white font-medium rounded-lg transition-colors text-sm"
          >
            {isSubmitting ? 'Queueing...' : '⏰ Queue Message'}
          </button>
        </div>
      </div>
    </div>
  );
};
