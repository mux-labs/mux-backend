import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StellarTransactionBuildService {
  private readonly logger = new Logger(StellarTransactionBuildService.name);

  buildTransaction(data: {
    amount: string;
    assetCode: string;
    assetType: string;
    destination: string;
    memo?: string;
  }): string {
    return JSON.stringify(data);
  }
}
