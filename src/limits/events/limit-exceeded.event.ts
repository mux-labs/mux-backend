import { VersionedDomainEvent } from '../../common/events/versioned-domain.event';

export class LimitExceededEvent extends VersionedDomainEvent {
  readonly schemaVersion = 1;

  constructor(
    public readonly userId: string,
    public readonly limitType: string,
    public readonly limit: number,
    public readonly attempted: number,
    timestamp?: Date,
  ) {
    super(timestamp);
  }
}
