/**
 * Base class for versioned domain events.
 * All internal domain events should extend this to include schema version.
 */
export class VersionedDomainEvent {
  /**
   * Event schema version - incremented when the event structure changes.
   * Consumers should use this to handle different event versions gracefully.
   */
  readonly schemaVersion: number = 1;

  /**
   * Timestamp when the event was created (UTC).
   */
  readonly timestamp: Date;

  constructor(timestamp?: Date) {
    this.timestamp = timestamp ?? new Date();
  }
}
