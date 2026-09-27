export enum FeeSponsorshipBudgetStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  CLOSED = 'CLOSED',
}

export enum FeeSponsorshipNetwork {
  MAINNET = 'MAINNET',
  TESTNET = 'TESTNET',
}

export interface FeeSponsorshipBudget {
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
  deletedAt: Date | null;
}

/**
 * Actor context for authorization on fee sponsorship operations.
 * Deny-by-default: only the wallet owner or an explicitly authorized
 * delegate/guardian may manage fee sponsorship budgets.
 */
export interface SponsorshipActor {
  subjectId: string;
  role: 'owner' | 'delegate' | 'guardian' | 'api-key' | 'jwt';
  correlationId?: string;
}
