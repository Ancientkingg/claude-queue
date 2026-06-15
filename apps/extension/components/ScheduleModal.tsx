import React, { useState, useCallback, useEffect } from 'react';
import { computeSendTime } from '@/lib/reset-parser';
import { useThemeColors } from './queue-hooks';
import { parseConversationId } from '@/lib/conversation';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: ScheduleConfig) => void;
}

export interface ScheduleConfig {
  promptText: string;
  modelTarget: string;
  thinkingMode: boolean;
  scheduledAt?: string; // ISO 8601 absolute send time
  conversationId?: string | null;
}

type Mode = 'session' | 'absolute';

const OFFSET_OPTIONS = [
  { label: 'None', ms: 0 },
  { label: '1 min', ms: 60_000 },
  { label: '2 min', ms: 120_000 },
  { label: '5 min', ms: 300_000 },
] as const;

const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-8',            label: 'Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5' },
];

/** Map a claude.ai model-selector display label to an API model ID. */
function resolveModelId(displayLabel: string): string | null {
  const lower = displayLabel.toLowerCase();
  if (lower.includes('haiku'))  return 'claude-haiku-4-5-20251001';
  if (lower.includes('sonnet')) return 'claude-sonnet-4-6';
  if (lower.includes('opus'))   return 'claude-opus-4-8';
  if (lower.includes('fable'))  return 'claude-fable-5';
  return null;
}

/** Read the currently-selected model from claude.ai's model selector button.
 *  Returns [modelId, thinkingEnabled] or [null, false] if undetectable. */
function detectCurrentModel(): [string | null, boolean] {
  const btn = document.querySelector<HTMLElement>('[data-testid="model-selector-dropdown"]');
  if (!btn) return [null, false];
  const label = (btn.getAttribute('aria-label') ?? btn.textContent ?? '').replace(/^Model:\s*/i, '').trim();
  const thinking = /extended/i.test(label);
  const modelId = resolveModelId(label);
  return [modelId, thinking];
}

const DEFAULT_OFFSET_MS = 120_000; // 2 min
const DEFAULT_JITTER_S = 90;       // 0–90s

// ── Date/time helpers (for the "Specific time" picker) ───────────────────────────

/** Format a Date as the local value a <input type="datetime-local"> expects. */
function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Quick presets for the absolute picker, each returning a concrete Date. */
const TIME_PRESETS: { label: string; make: () => Date }[] = [
  { label: 'In 1 hour', make: () => new Date(Date.now() + 60 * 60_000) },
  { label: 'In 3 hours', make: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    label: 'Tonight 9 PM',
    make: () => { const d = new Date(); d.setHours(21, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d; },
  },
  {
    label: 'Tomorrow 9 AM',
    make: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; },
  },
];

// ── Component ────────────────────────────────────────────────────────────────

export const ScheduleModal: React.FC<ScheduleModalProps> = ({ isOpen, onClose, onSubmit }) => {
  const [mode, setMode] = useState<Mode>('session');
  const [offsetMs, setOffsetMs] = useState<number>(DEFAULT_OFFSET_MS);
  const [jitterSeconds, setJitterSeconds] = useState<number>(DEFAULT_JITTER_S);
  const [scheduledAt, setScheduledAt] = useState('');
  const [modelTarget, setModelTarget] = useState(MODEL_OPTIONS[0].id);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset-time detection (from background, populated by webRequest capture).
  const [resetAtMs, setResetAtMs] = useState<number | null>(null);

  const CL = useThemeColors();

  useEffect(() => {
    if (!isOpen) return;
    setMode('session');
    setOffsetMs(DEFAULT_OFFSET_MS);
    setJitterSeconds(DEFAULT_JITTER_S);
    setScheduledAt(toLocalInputValue(new Date(Date.now() + 60 * 60_000))); // default: +1h
    setIsSubmitting(false);

    // Detect the currently-selected model from claude.ai's UI so the default
    // matches what the user already has selected in the model dropdown.
    const [detectedModel, detectedThinking] = detectCurrentModel();
    if (detectedModel) {
      setModelTarget(detectedModel);
      setThinkingMode(detectedThinking);
    } else {
      setModelTarget(MODEL_OPTIONS[0].id);
      setThinkingMode(false);
    }

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const res = await browser.runtime.sendMessage({ type: 'GET_RESET_TIME' });
        if (!cancelled && res?.ok && typeof res.resetAtMs === 'number') {
          setResetAtMs(res.resetAtMs);
          if (interval) clearInterval(interval); // got it — stop retrying
        }
      } catch { /* ignore */ }
    };
    poll();
    interval = setInterval(poll, 3000);
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, [isOpen]);

  const extractPromptText = useCallback((): string => {
    const editable = document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) return editable.textContent?.trim() ?? '';
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder]');
    if (textarea) return textarea.value.trim();
    return '';
  }, []);

  // Mid-point preview time (jitter rolled at submit; preview uses the average).
  const previewMs =
    mode === 'session' && resetAtMs != null
      ? computeSendTime(resetAtMs, offsetMs, jitterSeconds * 1000, Date.now(), () => 0.5)
      : null;

  const handleSubmit = useCallback(async () => {
    const promptText = extractPromptText();
    if (!promptText) {
      alert('Please type a prompt in the Claude chat input first.');
      return;
    }

    const config: ScheduleConfig = { promptText, modelTarget, thinkingMode };
    config.conversationId = parseConversationId(location.pathname);

    if (mode === 'absolute') {
      if (!scheduledAt) {
        alert('Please pick a date and time.');
        return;
      }
      config.scheduledAt = new Date(scheduledAt).toISOString();
    } else {
      if (resetAtMs == null) return; // button is disabled in this state
      const sendMs = computeSendTime(resetAtMs, offsetMs, jitterSeconds * 1000);
      config.scheduledAt = new Date(sendMs).toISOString();
    }

    setIsSubmitting(true);
    await onSubmit(config);
    setIsSubmitting(false);
  }, [extractPromptText, modelTarget, thinkingMode, mode, scheduledAt, resetAtMs, offsetMs, jitterSeconds, onSubmit]);

  if (!isOpen) return null;

  const sessionDisabled = mode === 'session' && resetAtMs == null;

  // ── Style helpers ────────────────────────────────────────────────────────
  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    color: active ? '#fff' : CL.muted,
    background: active ? CL.orange : 'transparent',
    transition: 'background 0.15s, color 0.15s',
  });
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '7px 6px',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
    border: `1px solid ${active ? CL.orange : CL.border}`,
    color: active ? '#fff' : CL.muted,
    background: active ? CL.orange : CL.surface,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  });
  const input: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
    color: CL.text, background: CL.surface, border: `1px solid ${CL.border}`,
    outline: 'none', boxSizing: 'border-box',
  };
  const label: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
    textTransform: 'uppercase', color: CL.muted, marginBottom: 8,
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 999999, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: CL.bg, border: `1px solid ${CL.border}`, borderRadius: 14,
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)', width: 380,
        maxHeight: '85vh', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${CL.border}`,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: CL.text, margin: 0 }}>Queue Message</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: CL.muted, fontSize: 22,
            cursor: 'pointer', lineHeight: 1, padding: 0,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Mode segmented control */}
          <div style={{
            display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: CL.surface,
          }}>
            <button onClick={() => setMode('session')} style={segBtn(mode === 'session')}>End of session</button>
            <button onClick={() => setMode('absolute')} style={segBtn(mode === 'absolute')}>Specific time</button>
          </div>

          {mode === 'session' && (
            <>
              {/* Detected reset time */}
              <div>
                <span style={label}>Detected reset</span>
                <div style={{ ...input, display: 'flex', alignItems: 'center', cursor: 'default' }}>
                  {resetAtMs == null
                    ? <span style={{ color: CL.muted }}>Waiting for claude.ai usage data…</span>
                    : <span style={{ color: CL.text }}>{new Date(resetAtMs).toLocaleString()}</span>}
                </div>
              </div>

              {/* Offset */}
              <div>
                <span style={label}>Offset after reset</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {OFFSET_OPTIONS.map((o) => (
                    <button key={o.label} onClick={() => setOffsetMs(o.ms)} style={chip(offsetMs === o.ms)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Jitter */}
              <div>
                <span style={label}>Random jitter (max seconds)</span>
                <input
                  type="number" min={0} max={600} value={jitterSeconds}
                  onChange={(e) => setJitterSeconds(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  style={input}
                />
              </div>

              {/* Preview */}
              {previewMs != null && (
                <div style={{ fontSize: 13, color: CL.green }}>
                  Will send around {new Date(previewMs).toLocaleTimeString()} (±{jitterSeconds}s)
                </div>
              )}
            </>
          )}

          {mode === 'absolute' && (
            <div>
              <span style={label}>Send at</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 10 }}>
                {TIME_PRESETS.map((p) => {
                  const v = toLocalInputValue(p.make());
                  return (
                    <button key={p.label} onClick={() => setScheduledAt(v)} style={chip(scheduledAt === v)}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="datetime-local"
                value={scheduledAt}
                min={toLocalInputValue(new Date())}
                onChange={(e) => setScheduledAt(e.target.value)}
                style={input}
              />
              {scheduledAt && !Number.isNaN(new Date(scheduledAt).getTime()) && (
                <div style={{ fontSize: 13, color: CL.green, marginTop: 10 }}>
                  {new Date(scheduledAt).getTime() <= Date.now()
                    ? '⚠ That time is in the past'
                    : 'Will send ' + new Date(scheduledAt).toLocaleString([], {
                        weekday: 'short', month: 'short', day: 'numeric',
                        hour: 'numeric', minute: '2-digit',
                      })}
                </div>
              )}
            </div>
          )}

          {/* Model */}
          <div>
            <span style={label}>Model</span>
            <select value={modelTarget} onChange={(e) => setModelTarget(e.target.value)} style={input}>
              {MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>

          {/* Thinking toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: CL.text }}>Extended Thinking</span>
            <button onClick={() => setThinkingMode(!thinkingMode)} style={{
              position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none',
              cursor: 'pointer', background: thinkingMode ? CL.orange : CL.surfaceHi,
              transition: 'background 0.15s', padding: 0,
            }}>
              <span style={{
                position: 'absolute', top: 2, left: thinkingMode ? 22 : 2, width: 20, height: 20,
                borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                transition: 'left 0.15s',
              }} />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 20px', borderTop: `1px solid ${CL.border}` }}>
          <button onClick={handleSubmit} disabled={isSubmitting || sessionDisabled} style={{
            width: '100%', padding: '11px 16px', borderRadius: 10, border: 'none',
            fontSize: 14, fontWeight: 600, color: '#fff', background: CL.orange,
            cursor: (isSubmitting || sessionDisabled) ? 'not-allowed' : 'pointer',
            opacity: (isSubmitting || sessionDisabled) ? 0.5 : 1, transition: 'opacity 0.15s',
          }}>
            {isSubmitting ? 'Queueing…' : sessionDisabled ? 'Waiting for reset time…' : 'Queue Message'}
          </button>
        </div>
      </div>
    </div>
  );
};
