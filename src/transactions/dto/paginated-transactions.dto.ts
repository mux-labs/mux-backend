import { Transaction } from '../entities/transaction.entity';

export class PaginatedTransactionsDto {
  data: Transaction[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
