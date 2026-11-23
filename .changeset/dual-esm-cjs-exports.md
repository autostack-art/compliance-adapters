---
'@compliance-adapters/backoff': minor
'@compliance-adapters/logger': minor
'@compliance-adapters/shared': minor
'@compliance-adapters/tracing-types': minor
'@compliance-adapters/metrics': minor
'@compliance-adapters/tracing': minor
'sep10-auth': minor
'sanctions-oracle': minor
'horizon-listener': minor
---

Ship ESM entry points alongside the CommonJS build. Each package now has an
`exports` map with `import`/`require`/`types` conditions; the ESM entry
(`dist/*.mjs`) is a thin wrapper re-exporting the CJS build, so there is a
single implementation and no dual-package hazard. Builds now use TypeScript
project references (`tsc -b`) for ordered, incremental builds.
