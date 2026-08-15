/**
 * @aibar/devtools — inspection overlay (docs/aibar-architecture.md §2.2, §13.4).
 *
 * A React panel that polls `kernel.debugSnapshot()` and tails the event bus:
 * context revision, surface state, degradation level, per-lane score
 * breakdowns, resolve timing, and the most recent kernel events. Read-only —
 * it never mutates kernel state, so it is safe to ship behind a flag.
 */

import { useEffect, useRef, useState } from 'react';

import type { AIBarEvent, AIBarKernel } from '@aibar/core';

const POLL_MS = 500;
const EVENT_TAIL = 30;

type Snapshot = ReturnType<AIBarKernel['debugSnapshot']>;

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 72,
  zIndex: 9999,
  width: 360,
  maxHeight: '60vh',
  overflow: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  lineHeight: 1.5,
  background: 'rgba(18, 18, 22, 0.94)',
  color: '#d6d6dc',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '10px 12px',
  boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
};

const headStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  marginBottom: 6,
};

const laneTitleStyle: React.CSSProperties = {
  marginTop: 8,
  marginBottom: 2,
  color: '#9a9aa4',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontSize: 9,
};

function fmtScore(score: Snapshot['lanes']['contextual'][number]['score']): string {
  return `Σ${score.total.toFixed(2)} (r${score.relevance.toFixed(1)} f${score.frecency.toFixed(1)} p${score.pin.toFixed(1)})`;
}

export interface AIBarDevtoolsProps {
  kernel: AIBarKernel;
}

export function AIBarDevtools({ kernel }: AIBarDevtoolsProps) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<{ seq: number; label: string }[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    setSnap(kernel.debugSnapshot());
    const timer = setInterval(() => setSnap(kernel.debugSnapshot()), POLL_MS);
    const off = kernel.events.on((e: AIBarEvent) => {
      const seq = (seqRef.current += 1);
      const { type, ...rest } = e as { type: string } & Record<string, unknown>;
      const detail = Object.entries(rest)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      setEvents((prev) => [{ seq, label: `${type} ${detail}`.trim() }, ...prev].slice(0, EVENT_TAIL));
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [kernel]);

  if (!snap) return null;

  const lanes: [string, Snapshot['lanes']['contextual']][] = [
    ['contextual', snap.lanes.contextual],
    ['system', snap.lanes.system],
    ['suggestions', snap.lanes.suggestions],
  ];

  return (
    <div style={panelStyle} data-aibar-devtools>
      <div style={headStyle}>
        <strong>AIBar devtools</strong>
        <span>
          rev {snap.context.revision} · {snap.surfaceState} · {snap.lastResolveMs}ms
          {snap.degradeLevel > 0 ? ` · degraded L${snap.degradeLevel}` : ''}
        </span>
      </div>
      <div>
        epoch {snap.epoch} · reads [{snap.readSlices.join(', ') || '—'}]
        {snap.overflowed.length > 0 ? ` · overflow ${snap.overflowed.length}` : ''}
      </div>
      {lanes.map(([name, items]) => (
        <div key={name}>
          <div style={laneTitleStyle}>{name} ({items.length})</div>
          {items.map((p) => (
            <div key={p.id}>
              {p.collapsed ? '▸ ' : ''}{p.id} · {p.width}px · {fmtScore(p.score)}
            </div>
          ))}
        </div>
      ))}
      <div style={laneTitleStyle}>events</div>
      {events.map((e) => (
        <div key={e.seq}>{e.label}</div>
      ))}
    </div>
  );
}
