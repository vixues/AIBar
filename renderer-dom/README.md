# @aibar/renderer-dom

DOM implementation of `RendererBackend`. Import functional CSS once:

```ts
import { DOMRendererBackend } from '@aibar/renderer-dom';
import '@aibar/renderer-dom/styles.css';
```

Does not depend on React. Theme via `--aibar-*` CSS variables.
Optional `[data-phase=thinking|tooling|…]` live-tone styling is an extension
vocabulary, not a required host enum.
