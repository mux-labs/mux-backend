import { VersionedDomainEvent } from '../../common/events/versioned-domain.event';

export class PaymentCompletedEvent extends VersionedDomainEvent {
  readonly schemaVersion = 1;

  constructor(
    public readonly paymentId: number,
    public readonly amount: number,
    public readonly currency: string,
    public readonly userId: number,
    timestamp?: Date,
  ) {
    super(timestamp);
  }
}
