# Hello world

Interactive React host for `@aibar/react`. You should see a dark composer card
with an AIBar strip (Attach, Flash/Pro, temperature slider, Idle, Send).

```bash
cd packages && npm install && npm run build
cd examples/hello-world && npm run dev
```

Open the printed localhost URL. Try:

1. **Send** — a user bubble appears, Idle becomes Thinking → Answering, then a reply.
2. **Flash / Pro** and the **slider** — the next reply includes those values.
3. **Clear** — confirm dialog (INV-A8).
4. Narrow the window — extra items overflow; the ⋯ floor opens a palette drain.

See [host guide](../../docs/aibar-host-guide.md).
