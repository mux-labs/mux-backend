export class KeyValidatedEvent {
  constructor(
    public readonly publicKey: string,
    public readonly keyType: string,
    public readonly valid: boolean,
    public readonly timestamp: Date,
  ) {}
}
