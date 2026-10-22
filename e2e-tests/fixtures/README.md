# `denylist-gate.wasm`

Minimal standalone Soroban contract used **only** to exercise the e2e
deploy → sync → listen pipeline in this repo. It implements just enough of
`denylist-gate` to be useful for infrastructure testing:

- `add_to_denylist(address: Address)` — records the address and publishes a
  `denylist_added` event carrying it.
- `is_denylisted(address: Address) -> bool` — reads back what was recorded.

This is **not** the production `denylist-gate` contract. The real contract
lives in the separate `compliance-primitives` repo and has the full
compliance rule set (allowlists, expiries, attestations, etc.). Per the
top-level `e2e-tests/README.md`, when a build of that contract is available it
should replace this file:

```bash
cp ../compliance-primitives/target/wasm32v1-none/release/denylist_gate.wasm e2e-tests/fixtures/denylist-gate.wasm
```

## Rebuilding this fixture

Source lives in `denylist-gate-contract/`. To rebuild:

```bash
rustup target add wasm32v1-none
cd e2e-tests/fixtures/denylist-gate-contract
cargo build --target wasm32v1-none --release
cp target/wasm32v1-none/release/denylist_gate.wasm ../denylist-gate.wasm
```
