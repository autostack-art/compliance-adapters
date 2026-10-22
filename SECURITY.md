# Security

This document describes the trust model behind each package in this repo — who or what is
trusted, what happens when that trust is misplaced or violated, and the specific attack classes
each package was (and wasn't) designed to resist. It reflects an actual review of the current
code (`sep10-auth`, `sanctions-oracle`, `horizon-listener`), not a generic checklist, and should
be updated whenever the trust boundaries described here change.

If you're looking for how to report a vulnerability, skip to
[Reporting a vulnerability](#reporting-a-vulnerability).

## Cross-cutting theme

Every package in this repo follows the same shape: an off-chain component receives input from
some external source (a sanctions API, a signed challenge transaction, a Soroban RPC endpoint)
and, based on that input, either writes to chain state or forwards data downstream, with **no
independent corroboration step**. That's a deliberate simplicity trade-off for a reference/adapter
library, but it means the security of any real deployment rests almost entirely on the
trustworthiness of whatever is plugged into these seams (`SanctionsProvider`, `rpcUrl`, webhook
`url`, `homeDomains`/`webAuthDomain`/`serverAccountId`). This document calls out, package by
package, exactly what happens if that trust is misplaced.

---

## `sanctions-oracle`

### Who is authorized to trigger a sync, and what access does that imply

`syncSanctionsToDenylist` itself has no authorization check of its own — anyone able to run it
(the CLI, or a program embedding it) can call it. The real authorization boundary is one layer
down, at the chain: `createRpcDenylistWriter` signs and submits the `add_to_denylist` invocation
using the `Keypair` passed in as `sourceKeypair` (the CLI's `--secret-key` flag). Whatever
authority the `denylist-gate` contract grants that key's address (presumably an admin/operator
role — see `compliance-primitives`) is exactly the authority anyone holding that secret key has
over the on-chain denylist. Concretely:

- **The secret key *is* the authorization control.** There is no separate off-chain access-control
  layer in this package — no allowlisted callers, no audit-before-submit gate, no multi-party
  approval. If `--secret-key` (or the `sourceKeypair` passed programmatically) leaks — committed
  to source control, exposed via a misconfigured CI env var, logged, or shared in a support
  channel — the holder can flag arbitrary addresses on `denylist-gate`, i.e. censor arbitrary
  Stellar accounts from whatever the denylist gates, entirely independent of whether those
  addresses are actually sanctioned.
- **There's no undo path in this codebase.** `sync.ts` only ever calls `add_to_denylist`; there is
  no corresponding "remove" invocation implemented here. Whether the contract itself supports
  removal is out of scope for this package, but this package provides no way to reverse a bad
  write it made — recovery from a bad sync depends entirely on tooling outside this repo.
- **`--dry-run` is opt-in, not a default gate.** A live sync only requires `--contract-id`,
  `--rpc-url`, `--network-passphrase`, and `--secret-key` together; there is no confirmation
  prompt or required human-in-the-loop review step before addresses get written on-chain. Anyone
  who can invoke the CLI (or the equivalent programmatic call) with those four values present can
  cause writes immediately.
- **Treat CLI invocation parameters as part of the trust boundary.** In a CI/automation context,
  anyone who can influence the `--addresses`, `--contract-id`, or `--rpc-url` arguments (e.g. a
  PR that can modify a pipeline config) can redirect a sync to write unexpected addresses, or to a
  different contract/network than intended, without ever touching the secret key directly.

### What happens to on-chain state if the sanctions data feed is compromised or returns bad data

`syncSanctionsToDenylist` trusts `provider.checkAddress(address)` completely. There is no
cross-checking against a second source, no confidence/severity threshold, and no cap on how many
addresses can be flagged in a single run.

- **False positives are written straight to chain, automatically.** If a compromised or buggy
  provider (API key theft, DNS hijack of the upstream watchlist API, a bad deploy on the
  provider's side, or simply a provider bug) reports `flagged: true` for an address that isn't
  actually sanctioned, that address is submitted to `add_to_denylist` with no review step. Given
  the lack of a "remove" path noted above, this is effectively a griefing/censorship primitive
  against whoever wrote the compromised provider — including, if the attacker can guess or control
  which addresses are checked, the operator's own hot wallets or legitimate users.
- **A fully compromised feed can denylist addresses in bulk.** Nothing in `syncSanctionsToDenylist`
  rate-limits or caps `flagged.length` relative to `addresses.length`. A provider that starts
  returning `flagged: true` for every address it's asked about (e.g. after an upstream compromise
  or a provider-side outage that fails open to "flag everything") will have every one of those
  addresses written to the denylist in a single run, with no circuit breaker.
- **False negatives are a silent compliance gap, not a crash.** If a provider fails to flag an
  address that should be sanctioned (stale data, a provider bug, or an attacker who's compromised
  the feed specifically to keep their own address off it), `syncSanctionsToDenylist` has no way to
  detect this — it only acts on what the provider tells it.
- **Mitigations available today, not automatic:** run with `--dry-run` and review the JSON output
  before a live run; only wire in a `SanctionsProvider` whose upstream access controls, API key
  handling, and incident response you trust as much as you'd trust a direct write to the
  `denylist-gate` admin key, since that's the effective blast radius of a compromise. See
  [Provider Registry design](./sanctions-oracle/docs/provider-registry-design.md) for
  `ProviderRegistry`'s `any-flag-wins`/`majority-vote`/`priority-override` policies, which let a
  deployment require agreement across multiple independent providers before flagging address, and
  reduce (but do not eliminate) the blast radius of any single compromised feed.
- **`MockSanctionsProvider` is not a mitigation.** It's a static, hardcoded fixture shipped only
  for tests/local dev (see the warning banner in `src/mockProvider.ts`); it carries no real
  sanctions data and must never be wired into a live sync.

---

## `sep10-auth`

### Replay and reuse

`generateChallenge` builds a challenge transaction with a bounded validity window
(`timeoutSeconds`, default 300s) and `verifyChallenge` delegates to
`WebAuth.readChallengeTx`/`verifyChallengeTxSigners` from `@stellar/stellar-sdk`, which check the
transaction's time bounds, sequence number, `home_domain`/`web_auth_domain` `manageData` entries,
and signatures. That's a correct, stateless per-transaction check — but stateless is the key word:

- **Nothing in this package tracks which challenges have already been used.** There is no
  nonce/JTI registry, no "seen transaction hash" set, and no single-use enforcement anywhere in
  `verify.ts` or `middleware.ts`. A signed challenge transaction remains valid for *every* request
  made during its entire time-bound window, not just the first.
- **`createSep10Middleware` amplifies this by design.** Its own doc comment says it "expects the
  raw signed SEP-10 challenge XDR on every request" and re-verifies it each time — meaning the
  exact same bearer value is intentionally replayable for the whole challenge lifetime as a
  reference pattern. The comment flags that a production app should exchange this for a
  short-lived session token after the first verification, but nothing in the package enforces
  that; a deployment that copies this middleware as-is inherits full replay exposure for up to
  `timeoutSeconds` (which the caller can also set arbitrarily high, further widening the window).
- **Signed-challenge exfiltration is bearer-token exfiltration, with no revocation path.** Because
  the "session" is just a base64 XDR blob sent as `Authorization: Bearer <token>`, anyone who
  captures it — via request logging/log aggregation that captures headers, a compromised reverse
  proxy sitting in front of the app, browser dev tools, a malicious browser extension, or XSS
  reading wherever the client stored it — can replay it as the authenticated address until it
  expires. This package has no server-side session store, so **there is no way to revoke a leaked
  challenge before its natural expiry**; that capability, if needed, has to be built by whoever
  adopts the short-lived-session-token approach the middleware's comment recommends.

### Home-domain spoofing

`verifyChallenge` requires the caller to supply `serverAccountId`, `homeDomains`, and
`webAuthDomain` explicitly (`VerifyChallengeOptions`) — the SDK checks the challenge's
`manageData` entries against these, which is exactly the mechanism SEP-10's `home_domain` field
exists to defeat phishing with. The risk in this package is entirely about *how those values get
supplied*, not the check itself:

- **These three values must come from static, trusted server-side configuration — never from
  request input.** Nothing in `verify.ts` or `middleware.ts` enforces this; if a deployment reads
  `homeDomains`, `webAuthDomain`, or `serverAccountId` from a header, query parameter, or any other
  client-influenced source (for example, a naive multi-tenant setup that picks the expected domain
  based on the incoming `Host` header without validating it against an allowlist), an attacker can
  get a challenge accepted against a domain they don't operate, defeating the anti-phishing purpose
  of `home_domain` entirely.
- **`generateChallenge`'s default (`localhost:3000`) is a misconfiguration trap, not an attack by
  itself.** If a production deployment forgets to override `homeDomain`, every challenge it issues
  will advertise `home_domain: localhost:3000`. That doesn't hand an attacker anything directly,
  but it silently defeats the purpose of the field — a wallet checking that `home_domain` matches
  the site the user is actually on gets a meaningless value to check against, so a phishing clone
  of the real site would pass just as easily as the legitimate deployment.
- **`homeDomains` accepts an array.** `WebAuth.readChallengeTx` will accept a challenge whose
  `home_domain` matches *any* entry in that array. Each additional domain in the list is a domain
  a signed challenge can legitimately claim to be for; keep this list to exactly the domains you
  actually operate and treat it as security-sensitive configuration, not a convenience list to
  grow casually.
- **A mismatched `serverAccountId` breaks the guarantee the same way.** `verifyChallenge` doesn't
  derive the expected server key itself — it trusts whatever `serverAccountId` the caller passes.
  A multi-tenant app that selects the server keypair per request based on client-influenced input
  could end up verifying a challenge against the wrong (or attacker-supplied) server identity,
  which would let a forged challenge signed by a different key pass verification.

---

## `horizon-listener`

`HorizonListener` polls Soroban RPC (via `EventSource`, typically `RpcEventSource`) and, for each
`RawContractEvent` it receives, invokes an `onEvent` callback — the shipped reference pattern
wires that callback to `HttpWebhookSender`, which `POST`s the raw event as JSON to a configured
`url`. This package is the **webhook sender**, not a receiver — there is no inbound HTTP endpoint
implemented anywhere in this repo; receiving and acting on the webhook is left entirely to
whatever the operator points `HttpWebhookSender` at (see the minimal stub receiver in the package
README).

### Webhook trust boundaries

- **Outbound payloads are unauthenticated.** `HttpWebhookSender.send` POSTs
  `{ event: RawContractEvent }` with a `Content-Type: application/json` header and nothing else —
  no HMAC signature, no shared-secret header, no mTLS. Any receiver built against this pattern
  therefore has **no cryptographic way to distinguish a genuine event forwarded by this listener
  from a forged POST sent by anyone else who can reach the receiver's URL.** If a receiver
  built on this reference pattern is ever exposed somewhere reachable by untrusted clients (e.g.
  the public internet without a bearer/shared-secret check at the receiver), an attacker can
  fabricate arbitrary `RawContractEvent` payloads — fake denylist-add events, fake allowlist
  events, fabricated `contractId`/`ledger`/`topic`/`value` — and the receiver has no built-in way
  to tell they didn't come from the real listener. **Any consumer of this pattern must add its own
  authentication to the webhook payload (e.g. an HMAC over the body, or a bearer token) and/or
  independently re-verify important events against Soroban RPC directly before acting on them** —
  this package does not do that for you.
- **Optional HMAC signing (`signingSecret`) and its replay-window trust model.** When
  `HttpWebhookSenderOptions.signingSecret` is configured, requests instead carry an `X-Timestamp`
  header (Unix seconds) and an `X-Signature: sha256=<hex hmac>` header computed over
  `<timestamp>.<raw body>` (see `horizon-listener/README.md` for the full verification recipe).
  This protects against the forgery scenario above **only if the receiver actually verifies both
  headers**: recomputing the HMAC with a constant-time comparison confirms the request was signed
  by a holder of `signingSecret`, and checking that `X-Timestamp` falls within a bounded freshness
  window (e.g. 5 minutes) is what makes a captured request eventually stop being replayable. The
  sender does not enforce this window itself — it only stamps the timestamp — so a receiver that
  verifies the signature but skips the freshness check accepts a captured, validly-signed request
  indefinitely. There is also no per-request nonce or idempotency tracking: within the freshness
  window itself, a captured request can still be successfully replayed (once or many times) unless
  the receiver separately tracks and rejects previously-seen `(X-Timestamp, X-Signature)` pairs.
- **What a malicious or compromised receiver *cannot* do.** The trust relationship is one-way: the
  listener only reads the HTTP response status (`response.ok`) from the receiver and otherwise
  ignores the response body entirely. A compromised or malicious receiver cannot inject events,
  rewrite the polling cursor, or otherwise affect `HorizonListener`'s future behavior — the only
  source of truth for events is Soroban RPC (`eventSource.getEvents`), never the webhook receiver.
  It also cannot crash the listener: `onEvent` errors (which includes `HttpWebhookSender` throwing
  on a non-2xx response) are caught per-event in `listener.ts` and logged, not propagated, so the
  poll loop and cursor advancement continue regardless of what the receiver does. The worst a
  malicious/down/slow receiver can do from this side of the boundary is cause events to be dropped
  (logged as an error) rather than delivered — an availability/observability issue for whoever
  consumes the webhook, not a way to corrupt listener or on-chain state.
- **The `url` and `rpcUrl` are themselves trusted, operator-supplied configuration.** Neither
  `HttpWebhookSenderOptions.url` nor `RpcEventSourceOptions.rpcUrl` is ever derived from event data
  or any other untrusted input in this codebase, so there's no SSRF surface from the data path
  itself — but that also means whoever controls that configuration (e.g. through a compromised CI
  pipeline or config store) controls where every future event gets sent, or which RPC endpoint is
  treated as ground truth. If `rpcUrl` is ever pointed at a malicious or compromised RPC endpoint,
  the listener has no way to detect that and will faithfully forward whatever fabricated contract
  events that endpoint returns — the same "garbage in, garbage out" trust dependency described for
  `sanctions-oracle`'s provider above applies here to the RPC endpoint choice.

---

## Reporting a vulnerability

Please do not open a public GitHub issue for a suspected security vulnerability in any of these
packages — in particular anything affecting the `sanctions-oracle` sync path, SEP-10 verification
logic, or webhook handling described above.

Instead, please report it privately using
[GitHub's private security advisory feature](https://github.com/stellar-compliance-kit/compliance-adapters/security/advisories/new)
for this repository ("Security" tab → "Report a vulnerability"). This lets maintainers see, discuss,
and fix the issue before any public disclosure, and lets you track the report without needing a
separate contact channel.

When reporting, please include:

- The package and file(s) involved.
- A description of the trust assumption being violated (see the sections above for the trust
  model each package currently assumes) and the impact if it's broken.
- Steps to reproduce, or a minimal proof of concept, if you have one.

We'll acknowledge new reports and work with you on a fix and coordinated disclosure timeline
before any public write-up.
