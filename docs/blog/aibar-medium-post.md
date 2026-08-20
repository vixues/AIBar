# Beyond the Chat Box: Designing a Safe Action Surface for AI Agents

*What we learned while building AIBar, a context-aware control plane for agent chat*

![AIBar docked above the chat composer](./assets/aibar/01-hero-aibar-dock.png)

The first generation of AI interfaces treated conversation as the whole product. A user typed a request, the model returned text, and every useful outcome was expected to fit inside that exchange.

Agents changed the shape of the interface.

An agent does more than answer. It calls tools, asks for permission, generates files, opens interactive views, runs workflows, and proposes what to do next. Each capability introduces another control: Allow, Deny, Stop, Open, Export, Retry, Inspect, Continue.

Most products add those controls where the need first appears. Over time, actions become scattered across the composer, transcript, permission cards, canvas toolbars, and side panels. The model can describe the next step, but the interface does not provide one consistent place to take it.

We built **AIBar** to explore a different model: a persistent, context-aware action surface above the chat composer. Its purpose is narrow but important—make the next valid actions visible without allowing the agent to take control of the interface.

The initial interaction concept was inspired by Apple’s Touch Bar: a compact control strip that adapts to the current context. AIBar brings that pattern to agent interfaces, then extends it with provenance, safety gates, and fallback access outside the bar.

The implementation taught us that this is not primarily a toolbar problem. It is a policy, protocol, layout, and trust problem.

## From conversation plane to action plane

A transcript is good at preserving meaning. It is less effective as a control surface.

When an agent produces a report, the transcript should explain the result. The action plane should offer **Open report**. When a tool needs permission, the transcript may preserve the request, while the action plane provides **Allow** and **Deny**. When a generated interface is active, the action plane can expose **Focus**, **Screenshot**, and **Export**.

This separation gives the product two complementary planes:

- the **conversation plane**, where intent, reasoning, and results accumulate
- the **action plane**, where currently available operations are resolved and presented

AIBar does not replace the composer or inline interactive content. It creates a stable home for actions that would otherwise be duplicated across unrelated surfaces.

![Composer chrome mode versus typing input mode](./assets/aibar/02-chrome-vs-input-mode.png)

The distinction also creates an architectural constraint: no single participant should own the entire bar.

The host application owns essential controls such as Send, Stop, model selection, and approvals. The current product surface may contribute canvas or file actions. The agent may publish a small number of contextual next steps. A suggestion engine may offer low-risk predictions.

All of them share one limited spatial budget.

## The kernel decides; React renders

Our first important decision was to separate action policy from UI framework code.

```text
protocol       Item specs, validation, identifiers, transport messages
core           ContextHub, resolver, kernel, WireIngress, HostAdapter SPI
intent         Optional heuristic suggestions
renderer-dom   DOM measurement, rendering, pointer interaction
react          Surface mount
host           Product projections, action allowlist, confirmation gate
```

Context providers register with `ContextHub`. When state is invalidated, the hub coalesces updates, pulls metadata such as the active route, composer mode, available generated UI, and current approvals, then builds an immutable snapshot with a monotonically increasing revision.

The DOM backend measures the available space; the kernel then resolves the item set and geometry; the backend commits the resulting frame. React provides the mount point and host integration, but it does not own ranking or layout policy.

This separation gives us three useful properties.

First, the action model can be tested without a browser. Second, different renderers can share the same protocol and resolver. Third, product policy does not become an accidental side effect of component order.

![AIBar architecture layers](./assets/aibar/04-architecture-layers.png)

In a static toolbar, rendering first and hiding overflow later may be acceptable. In a context-aware surface, the resolver must understand priorities, provenance, safety, and reachability before anything is painted.

## Treat agent output as untrusted declarations

Letting an agent publish actions creates a tempting shortcut: ask the model to generate a component or an HTML fragment.

We rejected that model. AIBar accepts data, never executable interface code.

An agent-published action is a validated declaration:

```json
{
  "id": "agent.aibar.button.open-report",
  "type": "button",
  "labelKey": "Open report",
  "effect": "read",
  "parity": "chat:link-in-reply",
  "action": {
    "name": "open_file",
    "params": {
      "fileId": "<file id>"
    }
  }
}
```

The host decides how that declaration is rendered and whether its action is available. Wire payloads cannot contain JavaScript, React components, custom render functions, or arbitrary event handlers. Item types that can carry in-process code are never exposed to agents.

This is more than a security boundary. It is also a product boundary. The host remains responsible for accessibility, visual consistency, localization, confirmation, and fallback behavior.

The ingress layer stamps agent-published controls with visible provenance. They come from an agent rather than native product chrome, and the interface should never blur that distinction.

## Make safety part of the protocol

Safety is easier to preserve when it is represented in the item contract rather than inferred from button labels.

Items may classify their effect as:

- `read`
- `write`
- `destructive`

Approval items require an explicit effect. Agent-triggered destructive effects route through a host-owned confirmation or approval gate, while the suggestion policy permits only `read` and `write`.

Every item also declares **parity**: the non-AIBar path that can accomplish the same operation. An Open report button may point to a link in the assistant reply. An approval control may mirror a durable permission card. LeAgent mounts AIBar only on chat routes and not below a 640px viewport, so those fallback paths are part of the contract rather than an optional convenience.

Parity prevents a contextual convenience from becoming the only way to use the product.

## Layout is resource allocation

A narrow horizontal strip cannot show every available action. That makes layout a resource-allocation problem.

Our resolver:

1. filters items by visibility and lifetime, then evaluates enablement
2. ranks eligible deterministic candidates
3. packs them against a measured spatial budget
4. applies hysteresis and a short dwell period to prevent flicker
5. moves deterministic items that do not fit into an overflow path

Deterministic actions and probabilistic suggestions use separate lanes. Suggestions are confidence-gated, capped in number, and placed only in the space left after deterministic layout. They cannot push out Send, Stop, an approval, or another host-owned action; suggestions that do not fit are simply omitted.

![Dual-lane resolver](./assets/aibar/09-dual-lane-resolver.png)

This distinction is subtle but important. If predicted actions compete directly with required controls, a more “intelligent” interface can become less dependable. Users need stable landmarks even while context changes.

The action surface should adapt without feeling random.

## The pointer event failure we did not expect

One of our most instructive bugs looked like an unreliable button.

AIBar re-resolves frequently. A composer focus change, streamed agent event, or layout measurement can produce a new frame. During a pointer gesture, this sequence can occur:

1. The browser dispatches `pointerdown` to an item.
2. New context triggers a render commit.
3. The renderer replaces the original DOM node.
4. The browser never dispatches the expected compatibility `click` to that node.

From the user’s perspective, the button simply does nothing.

The fix was to define primary activation as **arm on `pointerdown`, execute on `pointerup`**, then suppress the redundant compatibility `click`. Movement thresholds distinguish taps from horizontal scrub gestures.

![Pointer arming sequence](./assets/aibar/08-pointer-arming-diagram.png)

The broader lesson is that context-aware chrome behaves more like a small real-time runtime than a conventional toolbar. Input semantics must remain valid even when the visual tree changes mid-gesture.

## Project context; do not duplicate state

The composer owns the message draft. AIBar must not become a second source of truth.

Instead, the composer projects callbacks and limited metadata into the action surface. The bar can invoke Send or change reasoning intensity, but draft state remains in the composer.

For local typing suggestions, a private composer bridge exposes at most 32 characters immediately before the caret, not the full draft. That prefix never enters `ContextHub`, which keeps the shared context free of message content.

We also found that focus is not a reliable mode switch by itself. Opening an emoji popover or an inline reasoning selector briefly moves focus away from the textarea. Without additional state, the surface can switch back to its idle layout while the user is interacting with it. Latching expanded controls across short focus transitions prevents that instability.

Good projection contracts preserve ownership. They expose exactly what another subsystem needs, without copying the subsystem itself.

## Invariants are more valuable than features

As the catalog grew, the most valuable design work became a small set of invariants:

1. Every item has a fallback path or an explicit parity exception.
2. Agent transport payloads are data only.
3. Core policy stays independent of React and the DOM.
4. Stable identifiers are immutable and globally unique.
5. Suggestions never displace deterministic actions.
6. Agent provenance is always visible.
7. Agent-triggered destructive actions require a human gate.
8. Invalid agent payloads fail closed without taking down the surface.

These rules constrain future features in productive ways. A new item type is not complete merely because it renders. It must also define identity, provenance, safety, fallback behavior, and competition for space.

That is the difference between a collection of controls and an action-surface protocol.

## What we would carry into another agent product

If we were starting a different agent interface tomorrow, we would keep five principles:

**Separate meaning from action.** Let the transcript explain; give operations a dedicated plane.

**Keep the host in control.** Agents should declare intent through a narrow protocol, not author executable UI.

**Model trust explicitly.** Provenance belongs in the ingress contract; effect classification belongs in the item contract.

**Protect deterministic controls.** Prediction should add convenience without weakening stable interaction.

**Design for fallback.** A contextual surface should accelerate workflows, never become a hidden dependency.

## The larger direction

Agent interfaces are moving beyond chat, but abandoning chat is not the answer. Conversation remains a powerful way to express intent and understand results.

The missing layer is operational: a place where available actions can be reconciled across the model, the host, and the current task.

AIBar is our attempt to make that layer explicit. It is open source as a standalone engine and integrated into LeAgent:

- [AIBar repository](https://github.com/vixues/AIBar)
- [LeAgent repository](https://github.com/vixues/LeAgent)

The central idea is simple: an agent may propose the next move, but the host defines the rules and the user remains the final gate.
