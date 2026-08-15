# @aibar/core

Environment-free action-surface kernel: `AIBarKernel`, dual-lane resolver,
`WireIngress`, `AIBarHostAdapter`, `createDefaultHostAdapter`.

Re-exports `@aibar/protocol` so hosts can import `defineItem` and
`asItemIdentifier` from one package.

```ts
import { createDefaultHostAdapter, AIBarKernel, defineItem } from '@aibar/core';
```

INV-A4: no DOM, no React. See [architecture](../docs/aibar-architecture.md)
and the [host guide](../docs/aibar-host-guide.md).
