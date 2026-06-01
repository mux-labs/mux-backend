# Transactions: Add Stellar Transaction Build Service

## Summary

Adds `StellarTransactionBuildService` — a dedicated service that constructs unsigned Stellar payment transaction envelopes (XDR) using `stellar-sdk`. The XDR is returned to the caller for signing via `KeyManagementService`, keeping the build and sign steps cleanly separated.

## Changes

### New: `StellarTransactionBuildService`
`src/transactions/stellar-transaction-build.service.ts`

- `buildPayment(dto)` — fetches the source account sequence number from Horizon, builds a `TransactionBuilder` with the correct network passphrase, adds a payment operation and optional memo, returns `{ xdr, sequence, networkPassphrase }`.
- `buildXdr(dto)` — convenience alias that returns just the XDR string.
- Graceful error handling:
  - `BadRequestException` for missing issuer on non-native assets, 404 account not found, invalid destination key, or any `stellar-sdk` validation error.
  - `ServiceUnavailableException` for Horizon network failures.
- Supports both `TESTNET` and `MAINNET` via separate `Server` instances.

### New: `BuildTransactionDto` / `BuildTransactionResponseDto`
`src/transactions/dto/build-transaction.dto.ts`

Fields: `sourcePublicKey`, `destinationPublicKey`, `amount`, `assetCode`, `assetIssuer?`, `memo?`, `network`.

### Updated: `TransactionsModule`
`src/transactions/transactions.module.ts`

Added `StellarTransactionBuildService` to `providers` and `exports`.

### Updated: `TransactionsController`
`src/transactions/transactions.controller.ts`

Added `POST /transactions/build` endpoint (rate-limited via `@SensitiveEndpoint()`). Returns `BuildTransactionResponseDto`.

### Tests
`src/transactions/stellar-transaction-build.service.spec.ts` — 9 unit tests:
- XLM payment XDR generation
- Mainnet passphrase selection
- Non-native asset (USDC) with issuer
- Memo inclusion
- `BadRequestException` for missing issuer
- `BadRequestException` for 404 account (not found on Horizon)
- `ServiceUnavailableException` for Horizon network error
- `BadRequestException` for invalid destination key
- `buildXdr` alias

### Bug fix
Fixed invalid JSON in `package.json` (trailing comma after `stellar-sdk` dependency).

## API

```
POST /transactions/build
Body: {
  "sourcePublicKey": "G...",
  "destinationPublicKey": "G...",
  "amount": "10.0000000",
  "assetCode": "native",          // or "USDC", etc.
  "assetIssuer": "G...",          // required for non-native assets
  "memo": "optional text",
  "network": "TESTNET"            // or "MAINNET"
}

Response: {
  "xdr": "<base64-encoded unsigned transaction envelope>",
  "sequence": "12345678",
  "networkPassphrase": "Test SDF Network ; September 2015"
}
```

closes #212
