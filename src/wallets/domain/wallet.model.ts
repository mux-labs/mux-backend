export enum WalletNetwork {
  TESTNET = 'TESTNET',
  MAINNET = 'MAINNET',
}

export enum WalletStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export interface Wallet {
  id: string;
  userId: string;
  publicKey: string;
  network: WalletNetwork;
  status: WalletStatus;
  createdAt: Date;
  updatedAt: Date;
}
