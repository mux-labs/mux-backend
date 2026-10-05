import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiKeyService {
  async validateApiKey(_key: string): Promise<any> {
    return null;
  }

  async recordUsage?(_keyId: string): Promise<void> {}
}
