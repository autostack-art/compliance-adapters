// Test specifications for HorizonListener pagination handling
// Issue #335: Implement pagination handling for horizon-listener historical replay
//
// This spec documents the test coverage for the pagination/backfill feature:
//
// Historical replay with pagination:
// - startLedger option pages through all historical events before switching to polling
// - During backfill, pages are consumed immediately without sleeping between them
// - Listener transitions to normal polling once a page returns zero events (no more history)
// - Cursor is threaded through each getEvents call to track position
//
// Expected behavior:
// - First poll: called without cursor parameter
// - Subsequent polls: called with cursor from previous response
// - Historical pages: processed without sleep interval
// - Live transition: normal polling resumes when empty page received
//
// Test cases covered:
// - Cursor threading across multiple pages
// - Immediate consumption of historical pages (no sleep)
// - Transition from backfill to live polling
// - Event ordering preserved across page boundaries
//
// Implementation: horizon-listener/src/listener.ts
// Tests: horizon-listener/test/listener.test.ts (paginated event processing tests)
