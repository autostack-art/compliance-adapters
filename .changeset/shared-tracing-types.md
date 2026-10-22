---
'@compliance-adapters/tracing-types': minor
'sanctions-oracle': patch
'horizon-listener': patch
---

Extract the `TracingContext`, `SpanData`, `SpanStatus`, and `SpanAttributes`
type definitions into a new runtime-free `@compliance-adapters/tracing-types`
package. `horizon-listener` and `sanctions-oracle` now import these shapes from
the shared package instead of each declaring their own structurally-identical
copies, so a `TracingContext` produced by one package's tracer can be passed
directly as the `parentContext` to the other's `startSpan()` for cross-package
trace correlation. The types are re-exported from each package's `tracing`
module, so existing imports keep working.
