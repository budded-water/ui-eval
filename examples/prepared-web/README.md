# Prepared Web integration example

This synthetic candidate builds a page once with `prepare.mjs`, serves generated
output with `server.mjs`, and runs a post-capture digest check. The checked-in
integration suite is its acceptance configuration. The engine pin and standard
Web project/scenario are generated into a temporary independent candidate by
`scripts/verify-integration.mjs`; no stale revision is copied into this example.

From a clean authorized engine checkout with locked dependencies and Chromium:

```sh
bun run build
bun run verify:integration
```

The verifier uses the built CLI, an ephemeral loopback port and two locales, then
injects a failing after check and verifies candidate failure with original passing
browser reports. Scratch state is removed on completion. This exercises generic
preparation/acceptance, not Next.js, Vite, native devices or real WeChat DevTools.
