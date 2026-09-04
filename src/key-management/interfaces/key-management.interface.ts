import { KeyType } from '../domain/key-types';
import { KeyStatistics, KeyStatisticsQuery, DetailedKeyStatistics } from '../domain/key-statistics';
import { EncryptedKeyMaterial, SignatureResult, KeyOperationAudit } from '../domain/key-types';
import { GenerateKeyRequest, SignRequest, RotateKeyResult } from '../key-management.service';

/**
 * Public contract for the key management service.
 * Decouples consumers from the concrete implementation to allow
 * alternative backends (HSM, KMS, mock) to be swapped in cleanly.
 */
export interface IKeyManagementService {
  generateKey(request: GenerateKeyRequest): Promise<EncryptedKeyMaterial>;

  sign(request: SignRequest): Promise<SignatureResult>;

  validateKey(
    publicKey: string,
    encryptedKeyMaterial: string,
    keyType: KeyType,
  ): Promise<boolean>;

  reEncryptKey(
    encryptedKeyMaterial: string,
    keyType: KeyType,
    keyId?: string,
  ): Promise<EncryptedKeyMaterial>;

  rotateKey(predecessorWalletId: string): Promise<RotateKeyResult>;

  getAuditLog(limit?: number): KeyOperationAudit[];

  getStatistics(query?: KeyStatisticsQuery): KeyStatistics;

  getDetailedStatistics(query?: KeyStatisticsQuery): DetailedKeyStatistics;

  resetStatistics(): void;
}

export const KEY_MANAGEMENT_SERVICE = Symbol('IKeyManagementService');
