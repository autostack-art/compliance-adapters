---
'sanctions-oracle': minor
---

`SyncResult` now includes a `failedWithReasons` field: an array of
`{ address: string; error: string }` pairing every address in `failed` with
the message of the final error that caused its `provider.checkAddress` call to
fail after all retries. The existing `failed: string[]` field is unchanged, so
this is a backward-compatible addition. Callers can now decide programmatically
what to do with failed addresses (retry with a different provider, alert on
specific error types, distinguish rate-limit failures from provider errors)
without scraping log output.
