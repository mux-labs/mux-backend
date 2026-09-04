import { SetMetadata } from '@nestjs/common';

export const ALLOW_DURING_MAINTENANCE = 'allowDuringMaintenance';

/** Allows an exceptional mutating route, such as the maintenance toggle. */
export const AllowDuringMaintenance = () =>
  SetMetadata(ALLOW_DURING_MAINTENANCE, true);
