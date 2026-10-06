# Basic Web example

This dependency-free Node.js 20 example provides a deterministic local page for
the UI Eval CLI. The CLI owns the server lifecycle and writes generated evidence
under this example's ignored `.ui-eval/` directory.

Its policy uses the compact `web-default` profile and its smoke checkpoint
requests screenshot, console, network, and crash evidence. Add structured
channels or trace explicitly for geometry or additional diagnosis.

From the repository root:

```bash
bun install
bunx playwright install chromium
bun run ui-eval doctor --project-root examples/basic-web
bun run ui-eval evaluate home-desktop --project-root examples/basic-web
```

The configured server runs `node server.mjs` on `127.0.0.1:3210`. Keep that port
free before running `doctor` or `evaluate`; the configuration intentionally
refuses to reuse an unrelated process.
