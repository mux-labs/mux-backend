import { VersionedDomainEvent } from '../../common/events/versioned-domain.event';

export class LimitUpdatedEvent extends VersionedDomainEvent {
  readonly schemaVersion = 1;

  constructor(
    public readonly walletId: string,
    public readonly limitType: string,
    public readonly oldValue: number | null,
    public readonly newValue: number,
    timestamp?: Date,
  ) {
    super(timestamp);
  }
}
