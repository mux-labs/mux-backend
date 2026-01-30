export enum PaymentStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export class Payment {
  id: number;
  amount: number;
  currency: string;
  status: PaymentStatus;
  description?: string;
  fromId: number;
  toId: number;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
}
