import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, TransactionBuilder, Networks } from 'stellar-sdk';

@Injectable()
export class StellarSigningService {
  private readonly logger = new Logger(StellarSigningService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Signs a built but unsigned XDR transaction envelope using the server keypair.
   * Returns the signed XDR envelope as a base64 string.
   */
  signTransaction(unsignedXdr: string): string {
    const secret = this.configService.get<string>('STELLAR_SERVER_SECRET_KEY');
    if (!secret) {
      throw new InternalServerErrorException(
        'Server signing key is not configured',
      );
    }

    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      throw new InternalServerErrorException(
        'Server signing key configuration is invalid',
      );
    }

    const networkPassphrase =
      this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE') ??
      Networks.TESTNET;

    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
    } catch {
      throw new BadRequestException('Invalid XDR transaction envelope');
    }

    tx.sign(keypair);

    const signedXdr = tx.toEnvelope().toXDR('base64');
    this.logger.log(
      `Signed transaction with server key ${keypair.publicKey().substring(0, 12)}...`,
    );
    return signedXdr;
  }
}
