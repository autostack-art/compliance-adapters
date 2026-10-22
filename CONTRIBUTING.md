# Contributing to compliance-adapters

Thanks for your interest in contributing! This repo is the off-chain integration layer for the
[compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives) Soroban
contracts, and it's intentionally structured to have lots of small, well-scoped issues — a good
entry point if you're comfortable with TypeScript/Node but don't (yet) know Soroban internals.

## Drips Wave Stellar Program

This repo participates in the [Drips Wave](https://www.drips.network/) Stellar Program. Issues
are labeled by complexity so you can pick work that matches your available time and experience:

- `complexity: trivial` — small, self-contained, usually a few lines or a single test. Also
  tagged `good first issue`.
- `complexity: medium` — a feature or integration that touches one package meaningfully.
- `complexity: high` — cross-package design work, new abstractions, or security-sensitive changes.

Check open issues for the current bounty/reward status under the Drips Wave program before
starting work, and comment on an issue to claim it so we don't get duplicate PRs.

## Getting started

New to the Stellar ecosystem? Check the [Glossary](./docs/glossary.md) for definitions of common
terms like StrKey, SEP-10, muxed account, ScVal, and network passphrase before diving in.

```bash
git clone https://github.com/stellar-compliance-kit/compliance-adapters.git
cd compliance-adapters
npm install
npm test
```

Each package under the repo root (`sep10-auth/`, `sanctions-oracle/`, `horizon-listener/`) is an
independent npm workspace with its own `package.json`, `README.md`, and test suite. Run a single
package's tests with:

```bash
npm test --workspace=sep10-auth
```

## Development workflow

1. Fork the repo and create a branch off `main`.
2. Make your change, keeping it scoped to the linked issue.
3. Add or update tests — PRs that touch behavior without test coverage will be asked to add it.
4. Run `npm run lint` and `npm test` locally before opening a PR.
5. For release-related changes, add notes under `[Unreleased]` in the root `CHANGELOG.md`; maintainer release preparation moves those notes into a dated versioned entry.
6. Open a PR referencing the issue number (`Fixes #123`) and describe what you changed and why.

## Changeset policy

Changesets document updates to packages for the release changelog. Follow this policy when deciding whether a change needs a changeset:

**Changesets required for:**
- Changes to a package's public API surface (new exports, modified function signatures, removed functions)
- User-visible behavior changes to published packages (`sep10-auth`, `sanctions-oracle`, `horizon-listener`)
- Dependency bumps that may affect users
- Bug fixes in published packages

**Changesets NOT required for:**
- Internal refactors that don't change public APIs or behavior
- Test-only changes
- Documentation-only changes (README, JSDoc, comments)
- CI/tooling changes or root-level workspace changes
- License or metadata updates

To create a changeset for your PR, run `npm run changeset` and follow the prompts. Include a clear summary of the change and which packages it affects.

## Handling npm audit advisories

The CI workflow runs `npm audit --audit-level=high` to catch high-severity dependency vulnerabilities. In rare cases, a high-severity advisory may exist in a transitive dependency with no available fix, and the team may assess it as not applicable or acceptable given the dependency's usage context.

**Process for allow-listing an advisory:**

1. **Do not disable the check.** Loosening or disabling the audit check silently loses protection for every other advisory.
2. **Create an issue to track the advisory** including:
   - The advisory ID (from `npm audit` output)
   - The affected package and version
   - Why the team assesses the risk as acceptable (e.g., the vulnerable code path is not reachable given how the package is used)
   - A target expiry date (e.g., "revisit Q4 2026 when [upstream fix] is expected")
3. **Document the exemption** by adding the advisory ID to `.npmrc` or a similar audit-ignore config file with a comment linking to the tracking issue.
4. **Monitor for updates.** Check periodically (at least quarterly) whether the upstream fix is now available, and remove the exemption as soon as it is.

This preserves the audit check as a meaningful signal for new advisories while acknowledging that not every advisory can or should be fixed immediately.

## Branch protection (recommended)

The repository intends to enforce the following branch protection rules on `main` to ensure
stability and code review quality. These settings should be configured in the repository settings
by an admin; this document provides the single source of truth and rationale for maintainers.

- **Require pull request reviews before merging**: At least one approving review is required for all PRs. For
  security-sensitive or cross-package changes, request two reviewers.
- **Require status checks to pass before merging**: Enforce `npm run lint` and the test suite across workspaces.
  The exact status check names depend on CI configuration; ensure the CI publishes checks for lint and tests.
- **Dismiss stale pull request approvals when new commits are pushed**: Ensures reviewers re-check updated code.
- **Require branches to be up to date before merging**: Require PR branches to include the latest `main` to avoid
  merging with stale code.
- **Restrict who can push to `main`**: Only allow repository administrators to push directly; all changes should
  go through pull requests.

If you are an admin setting these rules, the above provides the intended configuration. If you are a contributor
and your PR is blocked by branch protection, follow the PR checks and request reviewers as described above.

## Package boundaries

This is a monorepo of three independent npm workspaces, each covering a distinct stage of the
compliance flow. When adding new functionality, use these boundaries to decide which package it
belongs in — or whether it warrants a new one.

- **`sep10-auth`** — Authenticates a Stellar address *before* any compliance check runs. Covers
  building and verifying [SEP-10 Web Authentication](https://stellar.org/protocol/sep-10)
  challenge transactions, plus a thin Express middleware that resolves the signed-in address for
  downstream handlers. It does not decide whether an address is compliant, and it does not collect
  signatures itself (that's the client wallet's job) — it only proves which address is making the
  request.

- **`sanctions-oracle`** — Decides whether an *already-authenticated* address is compliant, by
  checking it against a pluggable sanctions/watchlist data source (the `SanctionsProvider`
  interface) and syncing flagged addresses into a Soroban `denylist-gate` contract instance. New
  watchlist data sources, sync/retry logic, or provider registries belong here. It does not
  authenticate addresses (that's `sep10-auth`) and does not consume on-chain events (that's
  `horizon-listener`).

- **`horizon-listener`** — Reacts to on-chain state *after* the fact, by polling Soroban RPC for
  `denylist-gate` and `allowlist-token` contract events and re-emitting them (e.g. to a webhook).
  New event sources, delivery targets (queues, other webhooks), or backoff/retry strategies for
  consuming contract events belong here. It does not write to contracts or make compliance
  decisions — it only observes and forwards events other packages (or the contracts themselves)
  produced.

A rough mental model: `sep10-auth` answers "who is this?", `sanctions-oracle` answers "should this
address be blocked, and does the chain know that yet?", and `horizon-listener` answers "what just
changed on-chain?". If a change doesn't fit any of the three questions above, it likely warrants a
new package rather than being bolted onto an existing one — open an issue to discuss first.

- **`logger`** — The shared cross-package dependency: a minimal `Logger` interface plus a
  `consoleLogger` implementation, used instead of each package rolling its own logging shape.
  Convention: library code should accept an optional `Logger` and default to `noopLogger`; only
  CLI entrypoints should use `consoleLogger`/`console.*` directly.

## When to extract a shared package

When you find yourself duplicating utility code across packages (retry logic, metrics, logging,
backoff strategies), extract it into a new shared package under the monorepo root rather than
repeating the code.

**Decision criteria:**

- **Already extracted example**: The `@compliance-adapters/logger` package demonstrates the
  established pattern. When a utility is needed across package boundaries, it's extracted to its
  own workspace with its own `package.json`, tests, and documentation. Follow this pattern.
- **If used by just one package**: Keep it inside that package (e.g., a provider-specific utility
  in `sanctions-oracle`).
- **If used by two or more packages**: Extract to a new workspace. Examples of things that should
  not be duplicated: metrics/tracing instrumentation, backoff/retry logic, common error types.
- **Document the boundary**: Update this section of CONTRIBUTING.md if you create a new shared
  package, including its purpose and which packages depend on it.

## Code style

- TypeScript, Node 20+. Formatting is enforced by Prettier/ESLint (`npm run lint`).
- Prefer small, focused functions and explicit types on exported APIs.
- Don't vendor `compliance-primitives` contract code here — reference it as a dependency/link.

## Branch protection and required status checks

The `main` branch has branch protection enabled. **The CI workflow must be green before any PR
can be merged** — GitHub will block the merge button if the required status check hasn't passed.

The required check is the **"Lint & Test (TypeScript)"** job defined in
`.github/workflows/ci.yml`. It runs `npm run lint`, `npm run build`, and `npm test` across all
workspaces. All three steps must succeed for the check to pass.

What this means in practice:

- A red CI run is not just a warning — the PR is blocked until the check goes green.
- If you push a fix and CI still fails, push another commit; GitHub re-evaluates the check on
  every push to the PR branch.
- If the run looks like a flake (network timeout, rate-limit, etc.), use the **"Re-run failed
  jobs"** button on the Actions tab. Do not merge around a legitimate failure by temporarily
  disabling the rule — contact a maintainer if you believe the failure is environmental.
- Draft PRs are not blocked, but converting a draft to "Ready for review" will not remove the
  check requirement. The check still needs to be green before merge.

If you're unsure why CI is red, look at the failing step's log in the Actions tab; the lint and
build steps usually have the clearest error messages.

## Reporting bugs / requesting features

Use the issue templates under **New Issue** — one for bug reports, one for feature requests.

## Security

Please do not open a public issue for suspected security vulnerabilities in the sanctions-oracle
sync path, SEP-10 verification logic, or webhook handling. See [SECURITY.md](./SECURITY.md) for
each package's trust model and how to report a vulnerability privately.
