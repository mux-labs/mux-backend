import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Private Resource Authorization Policy:
 *
 * When accessing a private resource (e.g., a user's wallet, transaction):
 *
 * 1. RESOURCE FOUND + AUTHORIZED → Return resource (200)
 * 2. RESOURCE NOT FOUND + AUTHORIZED → Throw NotFoundException (404)
 * 3. RESOURCE FOUND + NOT AUTHORIZED → Throw ForbiddenException (403)
 * 4. RESOURCE NOT FOUND + NOT AUTHORIZED → Throw NotFoundException (404)
 *    (Hide whether resource exists from unauthorized callers)
 *
 * This policy prevents information disclosure:
 * - Unauthorized callers cannot distinguish between "resource doesn't exist" and "you don't have access"
 * - Authorized callers get clear feedback about missing resources (404)
 */
@Injectable()
export class PrivateResourceService {
  /**
   * Checks authorization and existence of a private resource.
   * Throws ForbiddenException or NotFoundException as appropriate.
   * Returns the resource if authorized and found.
   *
   * @param resource - The resource to check (null if not found)
   * @param isAuthorized - Whether the caller is authorized to access this resource
   * @param resourceType - Human-readable name (e.g. "Wallet", "Transaction")
   * @param identifier - Human-readable identifier (e.g. "wallet-123")
   * @returns The resource if both conditions are met
   * @throws NotFoundException if resource not found OR caller not authorized
   * @throws ForbiddenException if resource found but caller not authorized
   */
  checkResourceAccess<T>(
    resource: T | null | undefined,
    isAuthorized: boolean,
    resourceType: string,
    identifier: string,
  ): T {
    const resourceExists = resource !== null && resource !== undefined;

    if (!isAuthorized) {
      // Hide existence from unauthorized callers
      throw new NotFoundException(
        `${resourceType} not found: ${identifier}`,
      );
    }

    if (!resourceExists) {
      // Authorized caller gets clear feedback
      throw new NotFoundException(
        `${resourceType} not found: ${identifier}`,
      );
    }

    return resource as T;
  }

  /**
   * Checks authorization of a private resource given an authorization predicate.
   * Use this when you need to fetch the resource first, then check authorization.
   *
   * @param resource - The resource to check
   * @param authorizeResource - Predicate function: (resource) => boolean
   * @param resourceType - Human-readable name (e.g. "Wallet", "Transaction")
   * @param identifier - Human-readable identifier (e.g. "wallet-123")
   * @returns The resource if authorization passes
   * @throws NotFoundException if resource is falsy
   * @throws ForbiddenException if authorization fails
   */
  checkResourceAccessWithPredicate<T>(
    resource: T | null | undefined,
    authorizeResource: (r: T) => boolean,
    resourceType: string,
    identifier: string,
  ): T {
    if (!resource) {
      throw new NotFoundException(
        `${resourceType} not found: ${identifier}`,
      );
    }

    if (!authorizeResource(resource)) {
      throw new ForbiddenException(
        `You do not have permission to access this ${resourceType}`,
      );
    }

    return resource;
  }

  /**
   * Checks authorization for a resource owned by a specific user.
   * Common pattern: "current user can only access their own resources"
   *
   * @param resource - The resource to check
   * @param resourceOwnerId - The ID of the resource owner
   * @param currentUserId - The ID of the current user
   * @param resourceType - Human-readable name (e.g. "Wallet")
   * @param identifier - Human-readable identifier
   * @returns The resource if owner matches current user
   * @throws NotFoundException if resource not found
   * @throws ForbiddenException if owner doesn't match current user
   */
  checkResourceOwnership<T extends { [key: string]: any }>(
    resource: T | null | undefined,
    resourceOwnerId: string,
    currentUserId: string,
    resourceType: string,
    identifier: string,
  ): T {
    return this.checkResourceAccessWithPredicate(
      resource,
      () => resourceOwnerId === currentUserId,
      resourceType,
      identifier,
    );
  }
}
