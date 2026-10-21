# Glossary of Stellar / SEP / Soroban Terms

This glossary covers terminology you'll encounter when working in this repo. If you're coming from
outside the Stellar ecosystem, start here before diving into the code.

---

## A

### Account
A record on the Stellar ledger identified by a public key. Accounts hold balances, have a sequence
number (used to prevent replay attacks), and can hold thresholds and signers for multi-sig.
→ [Stellar Docs: Accounts](https://developers.stellar.org/docs/learn/glossary#account)

### Allowlist
A set of addresses explicitly permitted to participate in a given operation. In this repo,
`allowlist-token` is a Soroban contract from
[compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives) that
enforces an on-chain allowlist for token transfers.
→ [SEP-8: Regulated Assets](https://stellar.org/protocol/sep-8)

### Anchor
A business or entity that issues assets on Stellar and provides on/off ramps between Stellar
assets and real-world value (e.g., fiat currency). Anchors implement SEP standards to integrate
with wallets and exchanges.
→ [Stellar Docs: Anchors](https://developers.stellar.org/docs/learn/glossary#anchor)

---

## B

### Base Fee
The minimum fee (in stroops) required per operation in a Stellar transaction. Set by network
validators through upgrades. As of writing, the base fee is 100 stroops (0.00001 XLM).
→ [Stellar Docs: Fees](https://developers.stellar.org/docs/learn/glossary#base-fee)

---

## C

### Challenge Transaction
A specially crafted, unfunded Stellar transaction used in the SEP-10 authentication flow. The
server generates it with a random nonce and the client signs it to prove ownership of their
keypair. See also: **SEP-10**.
→ [SEP-10 Spec](https://stellar.org/protocol/sep-10)

### Claimable Balance
A Stellar ledger entry that holds an asset and can be claimed by one or more specified accounts
under defined conditions (predicates). Used in regulated asset flows to hold funds while
compliance checks complete.
→ [Stellar Docs: Claimable Balances](https://developers.stellar.org/docs/learn/glossary#claimable-balance)

### Contract ID
A unique identifier for a deployed Soroban smart contract on the Stellar network. Represented as a
Stellar address (StrKey `C...` prefix). Used throughout this repo to target deployed instances of
`allowlist-token`, `denylist-gate`, and `jurisdiction-flag`.
→ [Soroban Docs: Contract IDs](https://developers.stellar.org/docs/build/smart-contracts/getting-started/deploy-increment-contract)

---

## D

### Denylist
A set of addresses blocked from participating in an operation. In this repo, `denylist-gate` is a
Soroban contract that enforces an on-chain denylist, typically populated by the
`sanctions-oracle` adapter from an external watchlist source.
→ [compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives)

---

## E

### Ed25519
The elliptic-curve signature scheme used by Stellar keypairs. A Stellar secret key is a 32-byte
Ed25519 private key; the corresponding public key is the account address. See also: **StrKey**.
→ [Stellar Docs: Keypairs](https://developers.stellar.org/docs/learn/glossary#keypair)

---

## H

### Home Domain
A domain name stored on a Stellar account that acts as a pointer to that account's
`stellar.toml` file. In SEP-10, the server's home domain is included in the challenge transaction
and verified by the client to prevent phishing.
→ [SEP-10 Spec §Home Domain](https://stellar.org/protocol/sep-10)

### Horizon
Stellar's REST API server that provides access to ledger data, account information, transaction
submission, and event streaming for the classic (non-Soroban) layer of the network.
→ [Horizon Docs](https://developers.stellar.org/docs/data/horizon)

---

## J

### Jurisdiction Flag
An on-chain marker (per account or asset) indicating a regulatory jurisdiction. The
`jurisdiction-flag` contract in `compliance-primitives` lets operators record and query these
flags. The `horizon-listener` adapter in this repo can react to changes in jurisdiction flags
emitted as contract events.
→ [compliance-primitives](https://github.com/stellar-compliance-kit/compliance-primitives)

### JWT (JSON Web Token)
A signed token returned by the SEP-10 server after a client successfully completes the
challenge/response flow. Downstream SEP services (SEP-6, SEP-24, SEP-31) accept this JWT as
proof of Stellar account ownership, avoiding repeated authentication.
→ [SEP-10 Spec §JWT](https://stellar.org/protocol/sep-10)

---

## L

### Ledger
A snapshot of the entire Stellar network state at a point in time. Stellar closes a new ledger
approximately every 5 seconds. Each ledger has a sequence number and records all transactions
applied in that round.
→ [Stellar Docs: Ledgers](https://developers.stellar.org/docs/learn/glossary#ledger)

### Lumens (XLM)
The native asset of the Stellar network. Used to pay transaction fees and maintain minimum account
balances (reserves). Not to be confused with other assets issued on Stellar.
→ [Stellar Docs: Lumens](https://developers.stellar.org/docs/learn/glossary#lumens)

---

## M

### Muxed Account
An extension to a standard Stellar account address that embeds an additional 64-bit integer ID
(`M...` StrKey prefix). Allows a single on-chain account to represent many logical sub-accounts
(e.g., per-user accounts at an exchange) without creating separate ledger entries.
→ [CAP-27: Muxed Accounts](https://stellar.org/protocol/cap-27)

---

## N

### Network Passphrase
A string that uniquely identifies a Stellar network and is included in every transaction before
signing. Prevents transactions signed for testnet from being replayed on mainnet (and vice versa).
Mainnet: `"Public Global Stellar Network ; September 2015"`. Testnet:
`"Test SDF Network ; September 2015"`.
→ [Stellar Docs: Network Passphrase](https://developers.stellar.org/docs/learn/glossary#network-passphrase)

---

## S

### Sanctions Oracle
In this repo, the `sanctions-oracle` package provides a `SanctionsProvider` interface for feeding
real-world watchlist data into the on-chain `denylist-gate` contract. A sanctions oracle bridges
an external compliance data source (e.g., OFAC SDN list) and the Stellar network.

### ScVal (Stellar Contract Value)
The union type used to pass data into and out of Soroban smart contract invocations. ScVal
variants include integers (`I32`, `I128`, `U128`), byte arrays, strings, addresses, maps, vectors,
and more. When calling contracts via `@stellar/stellar-sdk`, you construct and decode ScVals
explicitly.
→ [Soroban Docs: ScVal](https://developers.stellar.org/docs/learn/encyclopedia/contract-development/types/built-in-types)

### SEP (Stellar Ecosystem Proposal)
A numbered specification document that defines interoperability standards for the Stellar
ecosystem — analogous to Ethereum's EIPs or Bitcoin's BIPs. SEPs cover everything from asset
discovery to authentication to regulated asset flows.
→ [SEP Index](https://stellar.org/protocol)

### SEP-10 (Stellar Web Authentication)
The SEP that defines a challenge/response protocol for authenticating Stellar account ownership
over HTTPS — without submitting a transaction to the network. A server issues a signed challenge
transaction; the client signs it and returns it; the server verifies the signature and issues a
JWT. This repo's `sep10-auth` package implements both sides of this flow.
→ [SEP-10 Spec](https://stellar.org/protocol/sep-10)

### Soroban
Stellar's smart contract platform, introduced in Protocol 20. Soroban contracts are written in
Rust, compiled to WebAssembly, and executed on-chain. The on-chain compliance contracts that this
repo integrates with (`allowlist-token`, `denylist-gate`, `jurisdiction-flag`) are all Soroban
contracts.
→ [Soroban Docs](https://developers.stellar.org/docs/build/smart-contracts)

### Soroban RPC
A JSON-RPC endpoint provided by Stellar nodes for interacting with Soroban contracts: simulating
transactions, submitting them, reading contract state, and fetching contract events. The
`horizon-listener` package in this repo polls Soroban RPC for contract events.
→ [Soroban RPC Docs](https://developers.stellar.org/docs/data/rpc)

### Stroop
The smallest unit of XLM: 1 XLM = 10,000,000 stroops. Transaction fees are denominated in
stroops. Named after Jed McCaleb's dog.
→ [Stellar Docs: Stroop](https://developers.stellar.org/docs/learn/glossary#stroop)

### StrKey
Stellar's Base32-encoded string format for representing binary data (keys, contract IDs, etc.)
in a human-readable, checksummed form. Different prefixes indicate the type:
- `G...` — Ed25519 public key (account address)
- `S...` — Ed25519 secret key
- `C...` — Contract ID
- `M...` — Muxed account address
→ [Stellar Docs: StrKey](https://developers.stellar.org/docs/learn/glossary#strkey)

---

## T

### Testnet
Stellar's public test network, which mirrors mainnet capabilities but uses test XLM (obtainable
from Friendbot for free). All development and testing in this repo is designed to run against
testnet first. Network passphrase: `"Test SDF Network ; September 2015"`.
→ [Stellar Docs: Testnet](https://developers.stellar.org/docs/learn/glossary#testnet)

### Transaction
An atomic set of one or more operations submitted to the Stellar network. A transaction must be
signed by the source account's keypair(s), include a valid sequence number, and pay a fee. On
Soroban, a transaction can invoke a smart contract.
→ [Stellar Docs: Transactions](https://developers.stellar.org/docs/learn/glossary#transaction)

---

## W

### Webhook
An HTTP callback used by the `horizon-listener` package to forward contract events (e.g., an
address being added to or removed from a denylist) to an external service. The listener polls
Soroban RPC and re-emits matching events as HTTP POST requests to a configured webhook URL.

---

*This glossary covers the terms most relevant to this repo. For the full Stellar glossary, see
the [Stellar Developers documentation](https://developers.stellar.org/docs/learn/glossary).*
