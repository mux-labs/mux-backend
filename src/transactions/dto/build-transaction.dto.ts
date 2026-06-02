export class BuildTransactionDto {
  /** Stellar public key of the source account */
  sourcePublicKey: string;

  /** Stellar public key of the destination account */
  destinationPublicKey: string;

  /** Amount to send (string for precision, e.g. "10.5000000") */
  amount: string;

  /**
   * Asset to send.
   * Use "native" for XLM, or provide code + issuer for a custom asset.
   */
  assetCode: string; // "native" | "USDC" | etc.
  assetIssuer?: string; // Required when assetCode !== "native"

  /** Optional memo text (max 28 bytes) */
  memo?: string;

  /** Network: "TESTNET" | "MAINNET" */
  network: 'TESTNET' | 'MAINNET';
}

export class BuildTransactionResponseDto {
  /** Base64-encoded XDR of the unsigned transaction envelope */
  xdr: string;

  /** Source account sequence number used */
  sequence: string;

  /** Network passphrase used */
  networkPassphrase: string;
}
