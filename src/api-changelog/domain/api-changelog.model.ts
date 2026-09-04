export enum ChangeType {
  ADDED = 'ADDED',
  CHANGED = 'CHANGED',
  DEPRECATED = 'DEPRECATED',
  REMOVED = 'REMOVED',
  FIXED = 'FIXED',
  SECURITY = 'SECURITY',
}

export enum ChangeCategory {
  WALLETS = 'WALLETS',
  PAYMENTS = 'PAYMENTS',
  LIMITS = 'LIMITS',
  RECOVERY = 'RECOVERY',
  AUTHENTICATION = 'AUTHENTICATION',
  WEBHOOKS = 'WEBHOOKS',
  GENERAL = 'GENERAL',
}

export interface ApiChangelogEntry {
  id: string;
  version: string;
  changeType: ChangeType;
  category: ChangeCategory;
  title: string;
  description: string;
  affectedEndpoints?: string[];
  migrationGuide?: string;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
