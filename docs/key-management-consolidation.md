# Key Management Consolidation

This document describes how Mux consolidates custody key management across the
backend, and the invariants that custody key encryption at rest must uphold.
It is the companion to [`custody-security-model.md`](./custody-security-model.md).

## Goals

- A single, typed custody-key API used by every money-path caller.
- Custody key material encrypted at rest with a versioned envelope scheme.
- Fail-closed behavior on any decryption, version, or dependency failure.
- Deny-by-default authorization on every privileged custody-key entrypoint.

## Custody key encryption at rest

Custody key material is never stored in plaintext. Each wallet/key record stores
an **envelope** rather than raw key bytes:

| Field            | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `keyVersion`     | Version of the encryption key used to wrap this record.        |
| `ciphertext`     | AEAD ciphertext of the key material (never logged or returned).|
| `nonce`          | Per-record AEAD nonce.                                         |
| `aad`            | Associated data binding the record to its wallet/tenant id.    |

### Invariants

1. **No plaintext at rest.** Key material is only ever persisted inside an
   envelope. There is no plaintext fallback path.
2. **Version is explicit.** Every envelope records the `keyVersion` used to
   wrap it. Decryption selects the key by that version; it never guesses.
3. **Fail closed.** A missing key material, unknown/retired `keyVersion`, or
   authentication failure returns a stable typed error. The caller must not
   receive raw key material, ciphertext, nonces, or secrets in the error.
4. **Stable error codes.** Decrypt/encrypt failures surface stable codes
   (e.g. `CUSTODY_KEY_VERSION_UNKNOWN`, `CUSTODY_KEY_DECRYPT_FAILED`,
   `CUSTODY_KEY_MISSING`) plus a correlation id for ops triage.
5. **No secret leakage.** Errors and logs redact key material, ciphertext,
   JWTs, and webhook secrets. Metrics never carry raw key bytes.

### Key versions

- Key versions are monotonic and immutable once published.
- New writes use the current active version; reads honor the version recorded
  on the envelope so old records remain decryptable during rotation.
- Retiring a version requires that no live envelope references it; otherwise
  decryption fails closed rather than silently downgrading.

## Authorization

Every privileged custody-key entrypoint enforces authz (owner / delegate /
  guardian / API-key / JWT) before touching key material. New privileged
surfaces are **deny-by-default**: absent an explicit allow, the request is
rejected. Clients cannot bypass policy by supplying their own key version or
envelope fields.

## Idempotency and dependency failures

- Custody-key mutations require an idempotency key; replayed requests return
  the original result instead of re-applying the mutation.
- On dependency outage (DB/RPC/Horizon), writes fail closed. Reads that cannot
  be authenticated also fail closed rather than returning partial data.

## Observability

- Actionable, typed errors with correlation ids on every failure path.
- Metrics on money/realtime paths (encrypt/decrypt counts, version usage,
  authz denials) without leaking secrets or raw key material.

## Rollout and rollback

Changes to custody encryption land behind a feature flag / kill-switch when
money-path or mainnet-affecting. Rollback restores the previous active key
version and flag state; envelopes written under a newer version remain
readable because the version is recorded per record.

## References

- [`custody-security-model.md`](./custody-security-model.md)
- [`../SECURITY.md`](../SECURITY.md)
