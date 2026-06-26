import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FeatureFlagService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled(flagName: string, defaultValue = false): boolean {
    const raw = this.configService.get<string>(flagName);
    if (raw === undefined || raw === null || raw === '') {
      return defaultValue;
    }
    return raw.toLowerCase() === 'true' || raw === '1';
  }
}
