# Payment dry-run

`POST /v1/payments/dry-run` validates a payment request without creating a
payment or submitting anything to Stellar. The endpoint requires the same
`Authorization: Bearer <key>` authentication and uses the same request body as
`POST /v1/payments`.

The dry-run performs the checks that happen immediately before persistence:

- the sender wallet exists and is `ACTIVE`;
- self-payment policy permits the transfer;
- the receiver wallet exists; and
- configured per-transaction and daily wallet limits permit the amount.

Example request:

```http
POST /v1/payments/dry-run
Authorization: Bearer mux_test_example
Content-Type: application/json

{
  "walletId": "123e4567-e89b-12d3-a456-426614174000",
  "receiverWalletId": "123e4567-e89b-12d3-a456-426614174001",
  "amount": 25,
  "currency": "USD",
  "description": "Invoice preview",
  "fromId": 1,
  "toId": 2
}
```

Successful response (`200 OK`):

```json
{
  "dryRun": true,
  "valid": true,
  "preview": {
    "senderWalletId": "123e4567-e89b-12d3-a456-426614174000",
    "receiverWalletId": "123e4567-e89b-12d3-a456-426614174001",
    "fromId": 1,
    "toId": 2,
    "amount": 25,
    "currency": "USD",
    "status": "PENDING"
  },
  "checks": {
    "senderWallet": "ACTIVE",
    "receiverWallet": "FOUND",
    "paymentLimits": "PASSED"
  }
}
```

Validation errors use the API's normal error envelope. Missing or invalid API
keys return `401`; malformed input and inactive senders return `400`; missing
wallets return `404`; and wallet-limit failures return `422`.

Dry-run does not reserve funds, guarantee later submission, query or return
custody key material, write a payment row, sign a transaction, submit to
Horizon, or emit payment domain events. A later create request is validated
again because wallet state and limits may have changed.
