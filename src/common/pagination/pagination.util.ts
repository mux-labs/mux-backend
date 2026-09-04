import { BadRequestException } from '@nestjs/common';

export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Shared pagination envelope for list APIs (wallet/payment/transaction/custody flows).
 * Validates page/limit query params consistently instead of each module rolling its own.
 */
export function parsePagination(query: PaginationQuery): PaginationParams {
  const page =
    query.page !== undefined ? Number(query.page) : DEFAULT_PAGE;
  const limit =
    query.limit !== undefined ? Number(query.limit) : DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestException('page must be a positive integer');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
    );
  }

  return { page, limit, skip: (page - 1) * limit };
}

export function buildPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}
