import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key marking a mutating route that must stay reachable while
 * maintenance mode is enabled.
 */
export const ALLOW_DURING_MAINTENANCE = 'allowDuringMaintenance';

/**
 * Allows an exceptional mutating route — currently only the maintenance
 * toggle — to run while `MaintenanceGuard` is rejecting every other write.
 *
 * Without this exemption, turning maintenance mode on would lock operators
 * out of the one endpoint that can turn it off, so the exemption is itself a
 * privileged surface: the route behind it must still authenticate.
 */
export const AllowDuringMaintenance = () =>
  SetMetadata(ALLOW_DURING_MAINTENANCE, true);
