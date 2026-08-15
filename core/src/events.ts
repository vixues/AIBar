/**
 * Typed event taxonomy + in-process bus (docs/aibar-architecture.md §8.4–§8.5).
 *
 * Synchronous dispatch in registration order; a throwing listener is isolated
 * and counted, never breaking the fan-out.
 */
import type { AIBarItemIdentifier, EffectClass, Provenance } from '@aibar/protocol';

export type AIBarEvent =
  | { type: 'aibar.item.publish'; id: AIBarItemIdentifier; publisherId: string }
  | { type: 'aibar.item.update'; id: AIBarItemIdentifier; publisherId: string }
  | { type: 'aibar.item.dismiss'; id: AIBarItemIdentifier; reason: string }
  | { type: 'aibar.suggestion.shown'; id: AIBarItemIdentifier; confidence: number }
  | { type: 'aibar.suggestion.accepted'; id: AIBarItemIdentifier; confidence: number }
  | { type: 'aibar.suggestion.dismissed'; id: AIBarItemIdentifier; confidence: number }
  | { type: 'aibar.suggestion.expired'; id: AIBarItemIdentifier }
  | { type: 'aibar.approval.requested'; id: AIBarItemIdentifier; effect: EffectClass }
  | {
      type: 'aibar.approval.resolved';
      id: AIBarItemIdentifier;
      decision: 'allow' | 'deny';
      latencyMs: number;
    }
  | { type: 'aibar.surface.transition'; from: SurfaceState; to: SurfaceState; trigger: string }
  | {
      type: 'aibar.surface.layout';
      epoch: number;
      shown: AIBarItemIdentifier[];
      overflowed: AIBarItemIdentifier[];
    }
  | {
      type: 'aibar.action.invoked';
      id: AIBarItemIdentifier;
      actionName: string;
      provenance: Provenance;
      contextRevision: number;
    }
  | {
      type: 'aibar.action.completed';
      id: AIBarItemIdentifier;
      outcome: 'ok' | 'error';
      durationMs: number;
    }
  | { type: 'aibar.customization.changed'; sequence: AIBarItemIdentifier[] }
  /** Host-UI hook: the kernel never renders menus itself (INV-A4). */
  | { type: 'aibar.item.contextmenu'; id: AIBarItemIdentifier; x: number; y: number }
  /** Delegate lookup miss (§4.1): templateItems → makeItem both failed. */
  | { type: 'aibar.item.unresolved'; id: AIBarItemIdentifier }
  /** Custom slot DOM is ready for host portals (create/update of custom items). */
  | { type: 'aibar.custom-slot.mount'; kinds: string[]; epoch: number }
  /** §11.3 load-shedding ladder step (0 = full fidelity). */
  | { type: 'aibar.perf.degraded'; level: 0 | 1 | 2 };

export type SurfaceState = 'idle' | 'contextual' | 'live' | 'fnMode' | 'customizing';

export class EventBus {
  private listeners = new Set<(event: AIBarEvent) => void>();
  private errorCount = 0;

  emit(event: AIBarEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        this.errorCount += 1; // isolated: never breaks the fan-out
      }
    }
  }

  on(listener: (event: AIBarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerErrorCount(): number {
    return this.errorCount;
  }
}
