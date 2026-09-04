export class KeyGeneratedEvent {
  constructor(
    public readonly publicKey: string,
    public readonly keyType: string,
    public readonly timestamp: Date,
  ) {}
}
