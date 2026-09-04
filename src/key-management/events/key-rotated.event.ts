export class KeyRotatedEvent {
  constructor(
    public readonly predecessorWalletId: string,
    public readonly successorWalletId: string,
    public readonly successorPublicKey: string,
    public readonly timestamp: Date,
  ) {}
}
