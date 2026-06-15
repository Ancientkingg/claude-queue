import React, { useState, useCallback, useEffect } from 'react';

// ── Types ───────────────────────────────────────────────────────────────────────

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: ScheduleConfig) => void;
}

export interface ScheduleConfig {
  promptText: string;
  modelTarget: string;
  thinkingMode: boolean;
  scheduledAt?: string;
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
];

// ── Shared style constants (matching Claude's dark theme) ────────────────────────

const CL = {
  orange: '#da7756',
  bg: '#1a1a18',
  surface: '#2a2a27',
  border: '#3d3d38',
  text: '#e8e4dd',
  muted: '#9b9790',
} as const;

// ── Component ────────────────────────────────────────────────────────────────────

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
    const editable = document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) return editable.textContent?.trim() ?? '';

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder]');
    if (textarea) return textarea.value.trim();

    return '';
  }, []);

  const handleSubmit = useCallback(async () => {
    const promptText = extractPromptText();
    if (!promptText) {
      alert('Please type a prompt in the Claude chat input first.');
      return;
    }

    setIsSubmitting(true);

    const config: ScheduleConfig = { promptText, modelTarget, thinkingMode };

    if (mode === 'absolute' && scheduledAt) {
      config.scheduledAt = new Date(scheduledAt).toISOString();
    } else if (mode === 'delay') {
      const delay =
        selectedDelay === -1
          ? (parseInt(customDelayMinutes, 10) || 5) * 60
          : selectedDelay;
      config.delaySeconds = delay;
    }

    await onSubmit(config);
    setIsSubmitting(false);
  }, [
    extractPromptText, modelTarget, thinkingMode,
    mode, scheduledAt, selectedDelay, customDelayMinutes, onSubmit,
  ]);

  if (!isOpen) return null;

  // ── Inline style helpers ────────────────────────────────────────────────────

  const btnBase = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    color: active ? '#fff' : CL.muted,
    background: active ? CL.orange : CL.surface,
    transition: 'background 0.15s, color 0.15s',
  });

  const delayBtn = (active: boolean): React.CSSProperties => ({
    padding: '8px 4px',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
    border: active ? `1px solid ${CL.orange}` : `1px solid ${CL.border}`,
    color: active ? '#fff' : CL.muted,
    background: active ? CL.orange : CL.surface,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  });

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    color: CL.text,
    background: CL.surface,
    border: `1px solid ${CL.border}`,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: CL.text,
    marginBottom: 8,
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: CL.bg,
          border: `1px solid ${CL.border}`,
          borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
          width: 400,
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: `1px solid ${CL.border}`,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, color: CL.text, margin: 0 }}>
            Queue Message
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: CL.muted,
              fontSize: 22,
              cursor: 'pointer',
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Schedule Type */}
          <div>
            <span style={labelStyle}>Schedule Type</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setMode('delay')}
                style={btnBase(mode === 'delay')}
              >
                Delay
              </button>
              <button
                onClick={() => setMode('absolute')}
                style={btnBase(mode === 'absolute')}
              >
                Send At
              </button>
            </div>
          </div>

          {/* Delay Options */}
          {mode === 'delay' && (
            <div>
              <span style={labelStyle}>Delay</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {DELAY_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => setSelectedDelay(opt.seconds)}
                    style={delayBtn(selectedDelay === opt.seconds)}
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
                  style={{ ...inputStyle, marginTop: 8 }}
                />
              )}
            </div>
          )}

          {/* Absolute Time */}
          {mode === 'absolute' && (
            <div>
              <span style={labelStyle}>Send At</span>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                style={inputStyle}
              />
            </div>
          )}

          {/* Model */}
          <div>
            <span style={labelStyle}>Model</span>
            <select
              value={modelTarget}
              onChange={(e) => setModelTarget(e.target.value)}
              style={inputStyle}
            >
              {MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Thinking Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: CL.text }}>
              Extended Thinking
            </span>
            <button
              onClick={() => setThinkingMode(!thinkingMode)}
              style={{
                position: 'relative',
                width: 44,
                height: 24,
                borderRadius: 12,
                border: 'none',
                cursor: 'pointer',
                background: thinkingMode ? CL.orange : CL.surface,
                transition: 'background 0.15s',
                padding: 0,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: thinkingMode ? 22 : 2,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: '#fff',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  transition: 'left 0.15s',
                }}
              />
            </button>
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: `1px solid ${CL.border}`,
          }}
        >
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: 'none',
              fontSize: 14,
              fontWeight: 500,
              color: '#fff',
              background: CL.orange,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {isSubmitting ? 'Queueing...' : '⏰ Queue Message'}
          </button>
        </div>
      </div>
    </div>
  );
};
