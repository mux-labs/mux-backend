import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { WalletsService } from '../wallets/wallets.service';

export interface SorobanInvokeParams {
  walletId: string;
  contractId: string;
  method: string;
  args?: unknown[];
  network?: 'TESTNET' | 'MAINNET';
}

export interface SorobanInvokeResult {
  status: string;
  hash: string;
  returnValue?: unknown;
}

/**
 * Invokes Soroban smart contracts on behalf of a custodied wallet: builds the
 * invocation transaction, simulates it to obtain footprint/auth data, signs
 * with the wallet's key, submits it, and polls for the final result.
 */
@Injectable()
export class SorobanService {
  private readonly logger = new Logger(SorobanService.name);
  private readonly rpcTestnet: SorobanRpc.Server;
  private readonly rpcMainnet: SorobanRpc.Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly walletsService: WalletsService,
  ) {
    this.rpcTestnet = new SorobanRpc.Server(
      this.configService.get<string>(
        'SOROBAN_RPC_TESTNET_URL',
        'https://soroban-testnet.stellar.org',
      ),
    );
    this.rpcMainnet = new SorobanRpc.Server(
      this.configService.get<string>(
        'SOROBAN_RPC_MAINNET_URL',
        'https://soroban-rpc.stellar.org',
      ),
    );
  }

  async invokeContract(
    params: SorobanInvokeParams,
  ): Promise<SorobanInvokeResult> {
    const {
      walletId,
      contractId,
      method,
      args = [],
      network = 'TESTNET',
    } = params;
    const rpc = network === 'MAINNET' ? this.rpcMainnet : this.rpcTestnet;
    const passphrase =
      network === 'MAINNET' ? Networks.PUBLIC : Networks.TESTNET;

    const privateKey =
      await this.walletsService.getDecryptedPrivateKey(walletId);
    const keypair = Keypair.fromSecret(privateKey);

    let account;
    try {
      account = await rpc.getAccount(keypair.publicKey());
    } catch (error) {
      this.logger.error(
        `Failed to load source account for Soroban invocation on contract ${contractId}`,
        error,
      );
      throw new BadRequestException('Unable to load source account');
    }

    const contract = new Contract(contractId);
    const scArgs = args.map((arg) => nativeToScVal(arg));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call(method, ...scArgs))
      .setTimeout(30)
      .build();

    try {
      const simulated = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simulated)) {
        throw new BadRequestException(
          `Soroban simulation failed: ${simulated.error}`,
        );
      }

      const prepared = SorobanRpc.assembleTransaction(tx, simulated).build();
      prepared.sign(keypair);

      const sendResult = await rpc.sendTransaction(prepared);
      if (sendResult.status === 'ERROR') {
        throw new BadRequestException(
          'Soroban transaction submission was rejected',
        );
      }

      const finalResult = await this.pollTransaction(rpc, sendResult.hash);
      const succeeded =
        finalResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS;

      return {
        status: finalResult.status,
        hash: sendResult.hash,
        returnValue:
          succeeded && 'returnValue' in finalResult && finalResult.returnValue
            ? scValToNative(finalResult.returnValue)
            : undefined,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(
        `Soroban contract invocation failed for ${contractId}.${method}`,
        error,
      );
      throw new ServiceUnavailableException(
        'Soroban contract invocation failed',
      );
    }
  }

  private async pollTransaction(
    rpc: SorobanRpc.Server,
    hash: string,
    attempts = 10,
    delayMs = 1000,
  ) {
    for (let i = 0; i < attempts; i++) {
      const result = await rpc.getTransaction(hash);
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new ServiceUnavailableException(
      'Timed out waiting for Soroban transaction result',
    );
  }
}
