export class KeySignedEvent {
  constructor(
    public readonly publicKey: string,
    public readonly timestamp: Date,
  ) {}
}
