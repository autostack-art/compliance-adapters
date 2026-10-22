---
"horizon-listener": minor
---

Webhook secret rotation (`signingSecret` accepts an array, plus `verifyWebhookSignature` helper), `Idempotency-Key` header on every delivery, opt-in batched deliveries (`batchSize`, `batchMaxWaitMs`, `flush()`/`stop()`), and a `horizon_listener_ledger_lag` gauge.
