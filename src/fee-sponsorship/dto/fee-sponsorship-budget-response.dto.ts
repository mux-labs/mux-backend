import { FeeSponsorshipBudgetStatus, FeeSponsorshipNetwork } from '../domain/fee-sponsorship-budget.model';

/**
 * Response payload for fee sponsorship budget endpoints.
 */
export interface FeeSponsorshipBudgetResponse {
  id: string;
  walletId: string;
  sponsorId: string;
  limitAmount: string;
  remainingAmount: string;
  assetCode: string | null;
  assetIssuer: string | null;
  network: FeeSponsorshipNetwork;
  status: FeeSponsorshipBudgetStatus;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}
