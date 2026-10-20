---
'sanctions-oracle': minor
---

Add an optional `score` to provider `CheckResult` (carried through
`ProviderRegistry`) and `minScoreToBlock` to `SyncOptions`. Flagged results
scoring below the threshold are reported in the new `SyncResult.needsReview`
list and never written on-chain.
