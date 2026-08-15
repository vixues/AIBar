/**
 * Host Adapter SPI — the single integration contract between a host and AIBar
 * (docs/aibar-architecture.md §10). Implementing this interface is the
 * embedding. New capabilities land as optional members only (semver promise).
 */
import type { EffectClass, Provenance } from '@aibar/protocol';
import type { ContextProvider } from './context';
import type { AIBarItemInput } from './items';

export interface ActionInvocation {
  itemId: string;
  name: string;
  params: Record<string, unknown>;
  effect: EffectClass;
  provenance: Provenance;
  contextRevision: number;
}

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface EffectConfirmation {
  itemId: string;
  actionName: string;
  effect: EffectClass;
  summary: string;
  provenance: Provenance;
}

export type IconRenderable =
  | { kind: 'svg'; svg: string }
  | { kind: 'text'; text: string };

export interface HotkeyBinding {
  itemId: string;
  /** The host-side parity declaration, e.g. 'shortcut:workflow.rerun'. */
  parity: string;
  onTrigger: () => void;
}

export interface IntentSignal {
  contextRevision: number;
  route?: string;
  mode?: string;
  recentActions: string[];
}

export interface SuggestionCandidate {
  id: string;
  labelKey: string;
  icon?: string;
  action: { name: string; params?: Record<string, unknown> };
  confidence: number;
  reason: { code: string; args?: Record<string, unknown> };
  effect?: EffectClass;
}

export interface AIBarHostAdapter {
  /** Context slice sources (§5.2). */
  contextProviders: readonly ContextProvider[];

  /** Action dispatch sink; `name` must match the host's registered allowlist (§12.3). */
  dispatchAction(inv: ActionInvocation): Promise<ActionOutcome>;

  /**
   * The host action catalog names, advertised to wire publishers during the
   * `hello` → `welcome` capability negotiation (§9.2). Optional; when omitted
   * the welcome message advertises an empty action list.
   */
  actionAllowlist?(): readonly string[];

  /** Human gate for approval items and destructive effects (INV-A8). */
  confirmEffect?(req: EffectConfirmation): Promise<'allow' | 'deny'>;

  /** i18n: labelKey → localized string (synchronous, cacheable). */
  resolveLabel(key: string, opts?: Record<string, unknown>): string;

  /** Icon resolution: named ref → renderer-consumable icon data. */
  resolveIcon(ref: string): IconRenderable;

  /** Customization + preference persistence (keyed by customizationIdentifier). */
  persistence: {
    load(key: string): Promise<unknown | null>;
    save(key: string, value: unknown): Promise<void>;
  };

  /** Hotkey system bridge: register bindings declared via parity (INV-A1). */
  hotkeys?: { register(binding: HotkeyBinding): () => void };

  /** Theme token injection (design doc §4). */
  theme?: {
    tokens(): Readonly<Record<string, string>>;
    subscribe(onChange: () => void): () => void;
  };

  /** Optional suggestion-lane strategy injection (§6.2). */
  intent?: {
    predict(signal: IntentSignal): Promise<SuggestionCandidate[]>;
  };

  /**
   * Optional fn-mode alternate item set (§8.2): shown while the host holds
   * its fn-equivalent modifier. Declarations are in-process (trust tier 1).
   */
  fnModeItems?(): AIBarItemInput[];

  /** Telemetry hooks (optional; payloads contain no user content). */
  telemetry?: { onEvent(e: unknown): void };
}
