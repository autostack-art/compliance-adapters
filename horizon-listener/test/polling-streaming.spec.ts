// Test specifications for HorizonListener polling vs streaming mode
// Issue #334: Add configurable polling vs streaming mode for horizon-listener
//
// This spec documents the test coverage for the polling and streaming mode feature:
//
// mode: 'poll' (default)
// - Sleeps pollIntervalMs between every poll regardless of whether events were returned
// - Suitable for most use cases with predictable, fixed-interval polling
// - Test: verifies sleep is called with pollIntervalMs after each poll
//
// mode: 'stream'
// - Polls again immediately when events are returned (no sleep)
// - Sleeps pollIntervalMs only during quiet periods (empty polls)
// - Reduces latency for high-activity contracts without hammering RPC when idle
// - Test: verifies sleep is skipped after active polls, called during quiet periods
// - Test: verifies consecutive quiet polls trigger sleep on each
//
// Implementation: horizon-listener/src/listener.ts
// Tests: horizon-listener/test/listener.test.ts (describe blocks: 'mode: poll' and 'mode: stream')
