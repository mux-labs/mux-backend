import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TransactionBuilder,
  Asset,
  Operation,
  Networks,
  Memo,
  Server,
  BASE_FEE,
} from 'stellar-sdk';
import {
  BuildTransactionDto,
  BuildTransactionResponseDto,
} from './dto/build-transaction.dto';

/**
 * Builds unsigned Stellar transaction envelopes (XDR) for payment operations.
 *
 * Responsibilities:
 * - Fetch the source account sequence number from Horizon
 * - Construct a TransactionBuilder with the correct network passphrase
 * - Add a payment operation
 * - Return the unsigned XDR for the caller to sign via KeyManagementService
 *
 * This service does NOT sign transactions. Signing is handled by KeyManagementService.
 */
@Injectable()
export class StellarTransactionBuildService {
  private readonly logger = new Logger(StellarTransactionBuildService.name);
  private readonly horizonTestnet: Server;
  private readonly horizonMainnet: Server;

  constructor(private readonly configService: ConfigService) {
    const testnetUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
    const mainnetUrl = this.configService.get<string>(
      'STELLAR_HORIZON_MAINNET_URL',
      'https://horizon.stellar.org',
    );

    this.horizonTestnet = new Server(testnetUrl);
    this.horizonMainnet = new Server(mainnetUrl);
  }

  /**
   * Builds an unsigned payment transaction XDR.
   *
   * @throws BadRequestException for invalid inputs (bad public key, bad asset, etc.)
   * @throws ServiceUnavailableException when Horizon is unreachable or account not found
   */
  async buildPayment(
    dto: BuildTransactionDto,
  ): Promise<BuildTransactionResponseDto> {
    const {
      sourcePublicKey,
      destinationPublicKey,
      amount,
      assetCode,
      assetIssuer,
      memo,
      network,
    } = dto;

    // Validate asset configuration
    if (assetCode !== 'native' && !assetIssuer) {
      throw new BadRequestException(
        `assetIssuer is required for non-native asset "${assetCode}"`,
      );
    }

    const networkPassphrase =
      network === 'MAINNET' ? Networks.PUBLIC : Networks.TESTNET;

    const server =
      network === 'MAINNET' ? this.horizonMainnet : this.horizonTestnet;

    // Fetch source account (provides sequence number)
    let sourceAccount: Awaited<ReturnType<Server['loadAccount']>>;
    try {
      sourceAccount = await server.loadAccount(sourcePublicKey);
    } catch (error) {
      const msg: string = error?.message ?? String(error);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        throw new BadRequestException(
          `Source account ${sourcePublicKey} does not exist on ${network}`,
        );
      }
      this.logger.error('Horizon loadAccount failed:', error);
      throw new ServiceUnavailableException(
        'Stellar Horizon is unavailable. Please retry.',
      );
    }

    // Build asset
    const asset =
      assetCode === 'native'
        ? Asset.native()
        : new Asset(assetCode, assetIssuer);

    // Build transaction
    try {
      // Capture sequence before build() increments it
      const sequence = sourceAccount.sequenceNumber();

      const builder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      });

      builder.addOperation(
        Operation.payment({
          destination: destinationPublicKey,
          asset,
          amount,
        }),
      );

      if (memo) {
        builder.addMemo(Memo.text(memo));
      }

      // 30-second timeout is standard for Stellar transactions
      builder.setTimeout(30);

      const transaction = builder.build();
      const xdr = transaction.toEnvelope().toXDR('base64');

      this.logger.log(
        `Built payment XDR: ${sourcePublicKey.substring(0, 8)}... -> ` +
          `${destinationPublicKey.substring(0, 8)}... ${amount} ${assetCode} [${network}]`,
      );

      return {
        xdr,
        sequence,
        networkPassphrase,
      };
    } catch (error) {
      // stellar-sdk throws for invalid keys, bad amounts, etc.
      this.logger.error('TransactionBuilder failed:', error);
      throw new BadRequestException(
        `Failed to build transaction: ${error.message}`,
      );
    }
  }

  /**
   * Builds an XDR from a pre-validated BuildTransactionDto.
   * Alias kept for explicit naming in callers that only need the XDR string.
   */
  async buildXdr(dto: BuildTransactionDto): Promise<string> {
    const result = await this.buildPayment(dto);
    return result.xdr;
  }
}
