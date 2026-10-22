# `ProviderRegistry` design

Status: implemented (see `../src/ProviderRegistry.ts`).

## Problem

`syncSanctionsToDenylist` (see `../src/sync.ts`) takes a single `SanctionsProvider`.
Real deployments frequently want to check an address against more than one
data source at once — e.g. an OFAC-style global list, a regional list, and an
internal denylist maintained by the operator — and none of those sources are
individually authoritative. That requires two things this package didn't
have:

1. A place to register more than one `SanctionsProvider` and query all of
   them for a given address.
2. A rule for what to do when they disagree — one provider says an address
   is flagged, another says it isn't.

## Goals

- Querying multiple providers must not change the public shape consumers of
  `SanctionsProvider` already depend on. A `ProviderRegistry` should be a
  drop-in `SanctionsProvider` itself, so `syncSanctionsToDenylist` needs no
  changes to accept one in place of a single provider.
- Conflict resolution must be a configurable policy, not hardcoded — different
  operators have different risk tolerances (a bank-facing deployment may want
  "any flag wins"; an internal tool might prefer majority vote to reduce
  false positives from one noisy source).
- One provider erroring (network blip, upstream API outage) must not silently
  make the whole check fail if other providers can still answer — but it must
  also not be swallowed invisibly. Errors are surfaced in the detailed result
  even when the overall decision succeeds.
- No network calls, no I/O — the registry only orchestrates already-injected
  `SanctionsProvider` instances, same as the rest of this package.

## API

### Registration

```ts
const registry = new ProviderRegistry({ policy: 'any-flag-wins' });

registry.register('ofac-style', ofacProvider);
registry.register('regional-list', regionalProvider, { priority: 1 });
registry.register('internal-denylist', internalProvider, { priority: 0 });

registry.unregister('regional-list');
registry.listProviders(); // ['ofac-style', 'internal-denylist']
```

- `register(name, provider, options?)` — `name` must be unique per registry
  (registering the same name twice throws, to catch copy-paste config bugs
  rather than silently shadowing a provider). `options.priority` is only
  consulted by the `priority-override` policy; lower numbers win. Providers
  registered without an explicit priority sort after every prioritized one.
- `unregister(name)` — removes a provider; no-op-safe to call on a name that
  was never registered.
- `listProviders()` — registered names, for diagnostics/tests.

### Checking an address

`ProviderRegistry implements SanctionsProvider`, so it can be used anywhere a
single provider is expected:

```ts
const { flagged, source } = await registry.checkAddress(address);

await syncSanctionsToDenylist({ provider: registry, addresses, writer });
```

For callers that want the full per-provider breakdown (audit logging, a
compliance dashboard, debugging a disagreement), `checkAddressDetailed`
returns the richer shape `checkAddress` is built on top of:

```ts
const result = await registry.checkAddressDetailed(address);
// {
//   flagged: boolean,
//   source: string,
//   policy: 'any-flag-wins' | 'majority-vote' | 'priority-override',
//   results: [{ name, flagged, source }, ...],   // providers that answered
//   errors: [{ name, error }, ...],               // providers that threw
// }
```

### Provider errors

By default (`onProviderError: 'ignore'`, the default), a provider that throws
is excluded from the vote — its failure is recorded in `errors` but doesn't
change the outcome the way an actual "not flagged" answer would. Setting
`onProviderError: 'flag'` treats a throwing provider as if it had answered
`flagged: true` — a fail-closed posture for deployments that would rather
over-block on a data-source outage than risk under-blocking.

If every registered provider throws, the registry has no data to decide with
and throws `ProviderRegistryAllProvidersFailedError` rather than silently
returning `flagged: false` — a total outage should be loud, not a quiet
"nobody's sanctioned today."

## Conflict-resolution policies

### `any-flag-wins`

`flagged` is `true` if *any* responding provider flags the address. This is
the conservative default for compliance use cases: a hit on any list is
enough to act on. `source` lists every provider that flagged it
(`"internal-denylist:internal-v3, ofac-style:sdn-list"`); if none flagged it,
`source` lists every provider that cleared it, so the result is always
traceable to what actually ran.

### `majority-vote`

`flagged` is whichever answer a majority of responding (non-errored)
providers gave. Ties (relevant with an even number of responding providers,
e.g. 2-2, or after an error drops the pool to 1-1) are broken by
`tieBreak`, which defaults to `'flag'` (fail-closed) and can be set to
`'clear'`. This policy exists for the "reduce false positives from one noisy
source" case — a single overzealous provider no longer unilaterally flags an
address.

### `priority-override`

Providers are registered with a `priority` (lower wins). The
highest-priority provider that *didn't* error decides the outcome outright;
every other provider's answer is ignored for the decision (still visible in
`results` for audit purposes). This models "the internal denylist is
authoritative, external lists are advisory" or the reverse. If the
highest-priority provider errored, the next-highest that answered decides.

## Why not more policies (e.g. weighted voting, N-of-M threshold)?

Three policies cover the concrete scenarios in the issue (agreement,
plain disagreement, an authoritative source). Weighted/threshold voting is a
straightforward extension of `majority-vote`'s counting logic if a real
deployment needs it, but nothing in this repo's scope calls for it yet —
adding it speculatively would just be unused surface area to maintain.

## Non-goals

- The registry does not cache or dedupe concurrent checks for the same
  address — that's a concern for whatever calls `checkAddress` in a loop
  (see `syncSanctionsToDenylist`), not the registry itself.
- The registry does not retry a failed provider — providers are responsible
  for their own retry/timeout behavior, same as a standalone
  `SanctionsProvider` today.
