import { Injectable, InjectionToken } from '@nestjs/common';

export const PAYMENT_LIMITS_PORT = Symbol('PAYMENT_LIMITS_PORT') as InjectionToken;

@Injectable()
export abstract class PaymentLimitsPort {
  abstract checkLimits(
    walletId: string,
    amount: number,
    assetCode?: string,
  ): Promise<void>;
}
