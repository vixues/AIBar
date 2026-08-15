# AIBar

Context-aware action-surface engine. A host mounts a strip of declarative
items; membership, order, and geometry are resolved from live context.
Agents publish **data, never code**.

LeAgent is one host. This repository is the library.

| Package | Role |
|---------|------|
| `@aibar/protocol` | Item Spec v2, identifiers, predicate DSL, wire, JSON Schema |
| `@aibar/core` | Kernel, resolver, HostAdapter SPI (no DOM, no React) |
| `@aibar/intent` | Optional heuristic suggestion engine |
| `@aibar/renderer-dom` | DOM backend + `--aibar-*` CSS |
| `@aibar/react` | `AIBarSurface` mount (peer React 18/19) |
| `@aibar/devtools` | Optional inspection overlay |

**Docs:** [architecture RFC](docs/aibar-architecture.md) ·
[host guide](docs/aibar-host-guide.md)

**Versioning:** independent of any host (`0.1.0`, Changesets). A protocol bump
`aibar/2` → `aibar/3` is a major of `@aibar/protocol` and every consumer.

Publishing requires the npm org **`@aibar`**. First release is tag `v0.1.0`.
If that org cannot be claimed, switch package names to `@leagent/aibar-*`
before the first publish.

```bash
npm install && npm test && npm run build
```

Examples: `examples/hello-world` (React) and `examples/vanilla-dom` (no React).

## Used as a Git submodule (LeAgent)

[LeAgent](https://github.com/vixues/LeAgent) vendors this repo at `packages/`:

```bash
git clone --recurse-submodules git@github.com:vixues/LeAgent.git
# or after a plain clone:
git submodule update --init --recursive
```

LeAgent records a **pinned commit** of AIBar, not a branch. To bump:

```bash
cd packages
git fetch origin
git checkout <commit-or-tag>   # e.g. v0.1.1 or origin/main
cd ..
git add packages
git commit -m "chore: bump AIBar submodule"
```
