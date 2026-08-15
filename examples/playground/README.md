# Playground

One Vite app: React by default, vanilla DOM as a second entry. Shared catalog,
theme, and chrome live next to the two mounts.

| URL | Stack |
|-----|--------|
| [`/`](.) | `@aibar/react` |
| [`/vanilla.html`](vanilla.html) | `@aibar/core` + `@aibar/renderer-dom` |

```bash
cd packages && npm install && npm run build
cd examples/playground && npm run dev
```

Open the printed URL. Switch hosts from the nav. `?theme=light` / `?theme=dark`
force a scheme.

See the [root README](../../README.md) for screenshots and the
[host guide](../../docs/aibar-host-guide.md) to embed in your app.
