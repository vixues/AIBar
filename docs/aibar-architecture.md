# AIBar Architecture

> **Status:** RFC (extractable library)  
> **Protocol:** `aibar/2`  
> **Packages:** `@aibar/protocol` · `@aibar/core` · `@aibar/intent` · `@aibar/renderer-dom` · `@aibar/react` · `@aibar/devtools`

AIBar is a **context-aware action-surface engine**. A host mounts a strip of
declarative items; membership, order, and geometry are resolved from live
context under a shared layout budget. Agents publish **data, never code**.

This document is the contract for the published `@aibar/*` packages. Host
product features (LeAgent composer chrome, GenUI, Creature Ranch, chat SSE)
live outside the library — see [Part B](#part-b-leagent-host-not-part-of-the-library)
and the [host guide](./aibar-host-guide.md).

Related: [host guide](./aibar-host-guide.md).
LeAgent (reference host) lives in a separate repository and vendors this
library as a Git submodule.

---

## 1. Purpose

AIBar is the place where the **product**, the **host**, and an **agent** agree
on *what is actionable right now*. It is not a second chat input, not a
free-form HTML widget, and not a replacement for in-composer markdown actions.

Design analogues: AppKit `NSTouchBar` (definition + identifiers + customization),
CodeMirror (renderer-agnostic core), TipTap (thin React mount), Radix
(host-owned chrome, token theming).

---

## 2. Package layout and boundaries

Import direction is strictly downward. Nothing in the library imports a host
application.

```
@aibar/protocol        Item Spec v2, identifiers, predicate DSL, wire, validators
        ▲
@aibar/core            Kernel, ContextHub, resolver, WireIngress, HostAdapter SPI
        ▲
@aibar/intent          Optional heuristic suggestion engine
@aibar/renderer-dom    DOM RendererBackend + --aibar-* CSS
        ▲
@aibar/react           AIBarSurface mount + createAIBarKernel
@aibar/devtools        Optional read-only overlay
```

There is **no** umbrella package that re-exports React + DOM + protocol. A Node
or Python host can depend on `@aibar/protocol` alone.

### 2.1 Intent package

`@aibar/intent` is optional. The kernel calls `adapter.intent.predict` when
present. The heuristic engine stores **action identities + context keys**, never
user content, and never emits `destructive` suggestions (INV-A8).

### 2.2 Environment-free zones (INV-A4)

`protocol/`, `core/`, and `intent/` must not reference DOM globals or React.
All environment access flows through `RendererBackend` and `AIBarHostAdapter`.
`renderer-dom/` must not import React. ESLint restricted-imports and
`boundaries.test.ts` are the extraction canaries.

### 2.3 Signals and live cluster

A TC39-shaped signal helper exists for future sliced invalidation work; it is
**not** part of the 0.1 public API. Live Cluster morph (≥3 live items collapse
the rest; expand ≤240 ms, rate-limited 10 s / run) is kernel-owned presentation.

---

## 3. Item model

### 3.1 Identifiers

Reverse-URI, branded, unique:

```text
<namespace>.aibar.<type>.<key>
```

The identifier is the diff key, persistence key, telemetry key, hotkey-binding
key, and accessibility id. Array position is never identity.

- Kernel-synthesized chrome uses `core.aibar.*` (`overflow`, `escape-close`,
  `inline-collapse`, `system-toggle`, `live-cluster`).
- Hosts pick their own namespace (`com.example.aibar.button.send`).
- Wire publishers typically use `agent.aibar.<type>.<key>`.

Construct with `makeItemIdentifier(namespace, type, key)` only.

### 3.2 Item Spec v2

Publishers submit **declarative JSON** (`AIBarItemSpec`). Required even when
not displayed: `id`, `type`, `labelKey`, `parity` (INV-A1).

In-process host items (`AIBarItem` / `defineItem`) may add function predicates,
delegates, and `onInvoke`. Those never appear on the wire (INV-A3).

### 3.3 Catalog

Twenty types. Wire-publishable:

`button`, `mainButton`, `toggle`, `segmented`, `label`, `group`, `popover`,
`slider`, `colorPicker`, `candidateList`, `characterPicker`, `spacerSmall`,
`spacerLarge`, `spacerFlexible`, `liveStatus`, `suggestion`, `approval`

**In-process only** (`IN_PROCESS_ONLY_TYPES`): `scrubber`, `hostItemsProxy`,
`custom` — payloads are code.

Zones: `'contextual' | 'system'`. Wire items are forced to `contextual`. The
System Strip is host-only (`provenance.kind === 'host'`).

### 3.4 Definition and suggestion policy

`AIBarDefinitionSpec` mirrors the NSTouchBar property set:

- `customizationIdentifier` — immutable once shipped (INV-A5)
- `defaultItemIdentifiers` / `customizationAllowed*` / `customizationRequired*`
- `principalItemIdentifier` / `escapeKeyReplacementItemIdentifier`
- `suggestionPolicy` — `maxVisible`, `minConfidence`, `allowEffects`
- `overflowAction` — optional `ActionRef` for the overflow-floor extra button;
  omit to skip the palette drain

Default suggestion policy: `maxVisible: 2`, `minConfidence: 0.35`,
`allowEffects: ['read', 'write']` (destructive excluded).

---

## 4. Item registry

`ItemRegistry` owns runtime items. INV-A6: global identifier uniqueness.
`DuplicateIdentifierError` on cross-owner collision; upsert only if the same
owner republishes.

Trust tiers:

| Tier | Source | Predicates | Zone | TTL / quotas |
|------|--------|------------|------|--------------|
| 1 In-process | host `defineItem` / provider | functions OK | contextual or system | none |
| 2 Wire | `WireIngress` | closed DSL only | contextual | yes |

### 4.1 templateItems / delegate

NSTouchBar analogue: `templateItems` skip the delegate; `delegate.makeItem(id)`
is the lazy constructor. Misses emit `aibar.item.unresolved` and never crash.

### 4.4 hostItemsProxy

In-process proxy expansion, depth ceiling 2. Used by hosts that project a
dynamic child set (folders, recent files) without registering each child as a
top-level identifier.

---

## 5. Context

`ContextHub` holds an immutable snapshot with a monotonically increasing
`revision`. Invalidations coalesce (~32 ms). Unchanged slices short-circuit
re-evaluation.

Lifted optional slices (hosts may omit any of them):

- `route`, `mode`, `focus`, `selection`
- `runs` (`LiveRunDescriptor`), `agent` (`AgentContext` / `AgentPhase`)
- `capabilities`
- `state` — **namespaced host extension slot** for product-specific keys

Context is **metadata** (kinds, counts, ids, digests) — never raw conversation
or the full composer draft.

`AgentPhase` (`idle` | `preparing` | `thinking` | `answering` | `tooling` |
`awaiting_input` | `error`) is an optional live-tone vocabulary. The DOM
renderer may style `[data-phase=…]`; unknown phases are inert. Hosts are not
required to use these strings.

### 5.2 Providers

```ts
interface ContextProvider {
  id: string;
  collect(): ContextSlice;
  subscribe(onInvalidate: () => void): () => void;
}
```

`collect()` must be synchronous, pure, and cheap. The adapter’s
`contextProviders` list is registered at kernel construction;
`contextHub.register` is available for late providers.

---

## 6. Dual-lane resolver

Pure function: `ResolveInput → ResolvedPlan`. **Do not change these semantics
during extraction.**

**Deterministic lane** (everything except `type === 'suggestion'`):

1. Visibility filter + TTL
2. Enablement (throwing predicate → disabled/hidden, never crash)
3. Score: `0.4·priority + 0.3·relevance + 0.2·frecency + 0.1·pin + hysteresis + dwell`
4. Two-phase pack: admit by score (required / pinned / approval / principal /
   `mainButton` bypass elimination) → distribute preferred/flex or compress toward min
5. Compression ladder: family merge → homogeneous group ≥ 8 → scrubber, else popover trigger
6. Stability: hysteresis `+0.1`, dwell 800 ms, positional anchoring (P5), `mainButton` pin-leading

**Suggestion lane (INV-A7):**

- Competes **only** for leftover slack after deterministic packing
- Confidence-gated, effect-gated
- `maxVisible` slots; a suggestion that does not fit is omitted — zero cost to ignore
- Must not change deterministic `x` / `width` / overflow
- Kernel additionally suppresses the lane in popovers, customizing, fnMode, and degrade level ≥ 1

Chrome: System Strip right-anchored at preferred width; suggestion lane sits in
leftover slack left of system; overflow trigger only after a real spill;
`leadingInset` is presentation-scoped (0 on composer ground, escape-zone width
on subsurface).

### 6.2 Suggestion engine

Optional `adapter.intent.predict(IntentSignal) → SuggestionCandidate[]`.
Timeout 2 s. At most one suggestion replacement per 5 s. Unacted suggestions
expire at 30 s. Destructive predictions must be `approval`, never `suggestion`.

### 6.3 Scoring

Weights `SCORE_WEIGHTS = { wP: 0.4, wR: 0.3, wU: 0.2, wC: 0.1 }`. Explainable
and deterministic given identical inputs.

### 6.4 Correctness properties (P1–P6)

| Id | Rule |
|----|------|
| P1 | Displayed items satisfy visibility |
| P2 | No overlap; in-bounds; min/max widths |
| P3 | Required visible items shown **or** overflowed — never dropped |
| P4 | Identical inputs → identical plan |
| P5 | Survivors never invert relative order |
| P6 | Suggestions never perturb deterministic packing |

Property-tested in `resolver.properties.test.ts`.

### 6.5 Stability

Hysteresis bonus `HYSTERESIS_BONUS = 0.1`. Dwell `DWELL_MS = 800`. Freshly
shown items cannot be evicted by score decay during dwell.

### 6.6 Sliced invalidation

The last resolve records which context slices it actually read. A subsequent
invalidation of unread slices skips the wave.

---

## 7. RendererBackend

```ts
interface RendererBackend {
  mount(container: unknown, sink: SurfaceInputSink): void;
  measure(requests: readonly MeasureRequest[]): readonly MeasureResult[];
  commit(frame: RenderFrame): void;
  scheduleFrame(cb: () => void): void;
  postTask?(cb: () => void, priority: 'user-visible' | 'background'): void;
  surfaceWidth(): number;
  onResize(cb: () => void): () => void;
  applyThemeTokens(tokens: Readonly<Record<string, string>>): void;
  destroy(): void;
}
```

Kernel computes geometry; renderer applies blindly. `container` is `unknown`
so core stays DOM-free. `measure` is the **only** environment read before
packing. `commit` is writes-only.

`RenderOp`: `create | update | move | state | stream | remove`.
`SurfacePresentation`: `ground | subsurface` — whole-bar swap, no cross-layer
move interpolation (NSPopoverTouchBarItem analogue).

### 7.4 DOM renderer / zero-reflow

`DOMRendererBackend` implements the SPI with canvas text measurement,
ResizeObserver, WAI-ARIA toolbar + roving tabindex, pointer arming, press-and-hold
popovers, scrubber virtualization. `commit` uses `transform` + width; no layout
reads. Theme tokens are CSS variables `--aibar-*`; host `theme.tokens()` wins
over the reference dark/light fallbacks in `styles.css`.

### 7.6 Scrubber virtualization

Viewport slice + overscan (window 24, overscan 4). At or below 320 entries the
full track is painted so pointer capture survives a swipe.

---

## 8. Surface lifecycle

Construct kernel with adapter + definition → `register` / `registerProvider` →
`attach(backend, container)` → `detach` (state survives) → `destroy`.

React: `AIBarSurface` owns one `div`, constructs `DOMRendererBackend`, and
calls `attach` / `detach`. Optional `heightVariable` publishes the surface
height onto `document.documentElement` (default **off**; hosts that pad the
page pass e.g. `'--aibar-height'`).

Presentation: ground vs subsurface is a whole-bar replace. Escape Zone meaning
follows the visible layer. Inline expand (`expand: 'inline'`) splices children
into the ground strip with a leading collapse key — no Escape Zone swap.

### 8.1 Customizing

`enterCustomizing` / `exitCustomizing(save)` / `setCustomOrder` /
`setItemHidden` / `pin` / `unpin`. Hosts draw the sheet and context menu;
the kernel emits `aibar.item.contextmenu` and never renders menus (INV-A4).

Persistence keys (host storage is opaque):

```text
aibar.{customizationIdentifier|default}.stats    // frecency + pins
aibar.{customizationIdentifier|default}.custom   // order + hidden ids
```

### 8.2 fnMode

While the host holds its fn-equivalent modifier, `adapter.fnModeItems()`
replaces the contextual set. Declarations are in-process (trust tier 1).

### 8.3 Streams

`STREAMABLE_FIELDS = ['labelKey', 'progress', 'confidence', 'reason']`.
Wire `stream.delta` patches are restricted to this allowlist.

### 8.4–8.5 Events

Synchronous `EventBus`. Throwing listeners are isolated. Taxonomy includes
publish/update/dismiss/unresolved, suggestion shown/accepted/dismissed/expired,
approval requested/resolved, surface transition/layout, action invoked/completed,
customization changed, item contextmenu, custom-slot mount, perf degraded.

`aibar.custom-slot.mount` is the portal contract for `custom` items
(`data-custom-kind` on the DOM slot). `readSurface()` returns identifiers and
states only — not labels or DOM.

---

## 9. Wire protocol

One message set over WebSocket / SSE / postMessage / in-process bridges.
The library owns types + `WireIngress`; the host owns transport.

### 9.1 Predicate + validation

Closed DSL: `eq/ne/gt/gte/lt/lte/in/exists/all/any/not`. Operands are literals
or `ctx.*` paths. No functions, no eval. `validateItemSpec` /
`validatePublishBatch` / `validatePredicate` are dependency-free.

JSON Schema ships at `@aibar/protocol/item-spec.schema.json` for non-TS hosts.

### 9.2 Messages

`hello` → `welcome` (capabilities: item types + `actionAllowlist()`, quotas,
suggestion policy) → `publish` / `update` / `stream.*` / `revoke` / `renew` →
`ack` | `error`.

### 9.3 Quotas

Default: 32 items, 10 messages/s, 8 KiB/spec, 4 concurrent streams, TTL 10 min.

### 9.4 Ingress

`WireIngress` stamps provenance, enforces quotas and the streamable-field
allowlist, and turns malformed messages into `error` replies — never a crash.

---

## 10. Host Adapter SPI

Implementing `AIBarHostAdapter` **is** the embedding. New capabilities land as
**optional members only** (semver promise).

Required:

- `contextProviders`
- `dispatchAction(inv) → ActionOutcome` — `name` must match the host allowlist
- `resolveLabel(key, opts?)` — i18n; kernel falls back to `DEFAULT_CHROME_LABELS`
- `resolveIcon(ref) → { kind: 'svg', svg } | { kind: 'text', text }`
- `persistence.load/save`

Optional: `actionAllowlist`, `confirmEffect`, `hotkeys`, `theme`, `intent`,
`fnModeItems`, `telemetry`.

`createDefaultHostAdapter({ dispatchAction, ...overrides })` supplies English
chrome labels, Lucide-style SVG icons, memory persistence, dark reference
tokens, and an empty provider list. Pass `theme` for light/dark.

Kernel-synthesized `labelKey`s the host catalog should cover (defaults exist):

| Key | Where |
|-----|--------|
| `aibar.overflowOpenPalette` | overflow floor extra button |
| `aibar.overflowCount` | overflow trigger tooltip (`{ count }`) |
| `aibar.collapse` | inline collapse + Escape-zone close |
| `aibar.runningMany` | live-cluster popover (`{ count }`) |
| `aibar.systemExpand` / `aibar.systemCollapse` | system-strip toggle |
| `aibar.reason.${code}` | suggestion explainability |

---

## 11. Performance

### 11.2 Resolve budget

NFR-1: a resolve should stay on the order of **8 ms**. Sustained overruns walk
the degradation ladder.

### 11.3 Degradation ladder

Level 0 = full fidelity. Level 1+ suppresses the suggestion lane. Emit
`aibar.perf.degraded`.

Failure model: throwing predicates, providers, delegates, and event listeners
never break the surface. Invoke hang is 15 s. Intent predict timeout is 2 s.

---

## 12. Trust and privacy

### 12.3 Action allowlist

Action names are a **host catalog**, not protocol. `welcome.capabilities.actions`
advertises `adapter.actionAllowlist()`. Unknown names fail at dispatch.

### 12.4 Frecency

Local-only statistics (count + last timestamp, 7-day half-life) plus pins,
persisted under `.stats`. Never leave the host’s persistence adapter.

### 12.6 Intent timeout

Hung `predict` calls are skipped for that cycle (2 s).

Privacy: intent engines store action ids, not content. Telemetry payloads
contain no user content.

---

## 13. Observability

Typed events (§8.4). Optional `adapter.telemetry.onEvent`.
`readSurface()` for agent self-correction (identifiers only).

### 13.4 Devtools

`@aibar/devtools` is a read-only overlay over kernel APIs. Optional peer of
React. Not required to mount a surface.

---

## Appendix A. Invariants

These are load-bearing. Do not “simplify” them.

**INV-A1 — Parity.** Every item has `parity` (hotkey / menu / `none:<reason>`).
No AIBar-only capability. Validator rejects missing parity.

**INV-A3 — Data, never code, on the wire.** `scrubber` / `hostItemsProxy` /
`custom` rejected by `validateItemSpec`. Publishers cannot ship functions.

**INV-A4 — Kernel/protocol/intent are environment-free.** No DOM globals, no
React. Boundaries tests are the extraction canary.

**INV-A5 — `customizationIdentifier` immutable** once shipped. Persistence keys
derive from it.

**INV-A6 — Global identifier uniqueness.** Duplicate across owners is an error;
upsert only for the same owner.

**INV-A7 — Suggestion lane never displaces deterministic items.** Provenance
badges (`host` / `user` / `agent` / `remote`) remain visible. P6 is the lock.

**INV-A8 — Human gate.** `destructive` → `confirmEffect` (unless pinned user
item). Destructive predictions must be `approval`, never `suggestion`.

---

## Part B. LeAgent host (not part of the library)

LeAgent consumes the same `@aibar/*` packages as any other host.

### B.1 Mount

`AIBarDock` on chat routes (`/`, `/home`, `/home/*`), gated by `aibarEnabled`
and non-mobile. Process-wide singleton kernel so frecency survives remounts.
`AIBarSurface` with `heightVariable="--aibar-composer-height"`.

### B.2 Providers

Route, composer-focus, chat, layout, flow, execution, pdf — via host bridges
so providers never import React Router.

### B.3 / B.6 Adapter and confirm gate

`createLeAgentAdapter`: i18next, Lucide → SVG, `localStorage` prefixed
`leagent-`, GenUI action bus, `confirmEffect` → `AIBarConfirmGate`.

Allowlist (lockstep with `backend/leagent/services/aibar/schema.py`):
`send_message | open_url | open_artifact | open_file | navigate | patch_ui |
submit_form | run_workflow | resume_workflow | copy_to_clipboard |
download_artifact | host.openCommandPalette`.

### B.4 Catalog / agent ingress

Host catalog `com.leagent.aibar.*`. Composer / GenUI / approval / pet
projections stay in `frontend/src/features/aibar/`. Agent path: tool
`aibar_publish` → `AIBarService` → chat SSE → `WireIngress`.

### B.5 Intent

`HeuristicIntentEngine` + optional `POST /aibar/sessions/{id}/suggest`.
Mute categories and learning blob are host persistence, not kernel.
