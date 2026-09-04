import { VersionedDomainEvent } from '../../common/events/versioned-domain.event';

export class LimitWarningEvent extends VersionedDomainEvent {
  readonly schemaVersion = 1;

  constructor(
    public readonly walletId: string,
    public readonly limitType: string,
    public readonly limit: number,
    public readonly projected: number,
    timestamp?: Date,
  ) {
    super(timestamp);
  }
}
