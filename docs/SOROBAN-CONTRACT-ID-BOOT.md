# Soroban Contract ID Boot Validation

When `SOROBAN_INVOKE_ENABLED=true`, the application validates every configured
Soroban contract id **at boot** and refuses to start if any is missing, malformed,
or misconfigured.

Implemented by `SorobanContractBootValidatorService`
(`src/soroban/soroban-contract-boot-validator.service.ts`), registered in
`SorobanInvokeModule`. It runs on `OnModuleInit`, before the invoke surface can
serve traffic.

## Why

Without this gate, a bad contract id only surfaced as a confusing RPC failure on
the *first live invoke* — after the surface was already enabled and taking
traffic. The realistic failure modes are all operational mistakes:

- a truncated paste from a terminal or a wiki page
- an account `G...` address pasted where a contract id belongs
- the testnet id copied into the mainnet variable, so mainnet value is driven at
  a testnet deployment
- a contract added to the allowlist without deploying it on the network

All four are cheap to catch at boot and expensive to catch in production.

## Configuration

One variable per `(contract, network)` pair, named
`SOROBAN_CONTRACT_<CONTRACT>_<NETWORK>_ID`:

| Contract | Testnet | Mainnet |
|---|---|---|
| `wallet_registry` | `SOROBAN_CONTRACT_WALLET_REGISTRY_TESTNET_ID` | `SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID` |
| `spend_limit` | `SOROBAN_CONTRACT_SPEND_LIMIT_TESTNET_ID` | not required (testnet-only) |

A **mainnet** id is required only for contracts with at least one
`mainnetEnabled: true` function in `ALLOWED_CONTRACT_FUNCTIONS`. A testnet-only
contract therefore does not need a mainnet id, so a testnet-only deployment is
not blocked.

## Validation

An id is valid when all of the following hold:

1. Exactly 56 characters.
2. First character is `C`.
3. Every character is in the base32 alphabet `A-Z2-7`.
4. It decodes to 35 bytes whose leading version byte is the contract version byte
   (`2 << 3`) — this is what rejects a well-formed `G...` account address.
5. The CRC-16/XMODEM checksum over the version byte and payload matches.

Point 5 is a real decode-and-verify, not a regex. The implementation is local
rather than delegating to `@stellar/stellar-sdk` so that the boot gate cannot
degrade into "valid" merely because an import failed — a validator that returns
`true` on its own failure is worse than no validator. It is cross-checked against
`StrKey.encodeContract` / `StrKey.isValidContract` for randomly generated ids.

## Error codes

| Code | Meaning |
|---|---|
| `SOROBAN_CONTRACT_ID_MISSING` | No id configured for an allowlisted contract/network. |
| `SOROBAN_CONTRACT_ID_INVALID` | Configured value is not a valid contract id. |
| `SOROBAN_CONTRACT_ID_NETWORK_COLLISION` | The same id is configured for both networks. |

The boot failure message lists **every** offending variable, so an operator can
fix the whole set in one pass rather than one restart per mistake. It never
includes a configured id value.

## Invariants

1. **Fail-closed.** With the surface enabled, invalid configuration prevents
   startup. There is no "warn and continue".
2. **Network separation.** The same id on both networks is a copy-paste
   misconfig and blocks boot — driving mainnet value at a testnet deployment is
   exactly what this gate exists to prevent.
3. **Deny-by-default.** With `SOROBAN_INVOKE_ENABLED` unset, `false`, or any value
   other than `true`/`1`, the validator logs that it was skipped and returns.
   Findings are still computed and reported, so a deployment can see them before
   it ever enables the surface, but they do not block boot.
4. **No leakage in logs.** Logs carry allowlist contract names, networks, and
   error codes — never a configured id value, key material, or a secret.
5. **Driven by the allowlist.** The set of contracts that must be configured is
   derived from `ALLOWED_CONTRACT_FUNCTIONS`, so adding an allowlist row without
   deploying the contract is caught at the next boot.

## Rollback

The validator is read-only: it reads environment variables and refuses to start.
Reverting it does not require a config change, a migration, or a data backfill.
The immediate operational escape hatch, without a deploy, is to set
`SOROBAN_INVOKE_ENABLED=false` — that disables contract invocation entirely and
makes the gate inert.

## Tests

- `src/soroban/soroban-contract-boot-validator.service.spec.ts` — id validation
  and the full configuration matrix
- `test/soroban-contract-boot.e2e-spec.ts` — the gate driven through the Nest DI
  container

Related: [FEATURE-FLAGS.md](FEATURE-FLAGS.md), [WALLET-API.md](WALLET-API.md),
[../SECURITY.md](../SECURITY.md).

---
