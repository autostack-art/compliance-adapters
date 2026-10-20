---
'sanctions-oracle': minor
---

Dry-run can now estimate fees: pass `feeEstimator` (e.g.
`createRpcFeeEstimator`) or the RPC flags on the CLI to simulate one
representative `add_to_denylist` transaction. The result is reported as
`SyncResult.feeEstimate` in stroops and XLM; simulation failures are reported
in `feeEstimate.error` without failing the run.
