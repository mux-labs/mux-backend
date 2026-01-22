import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletSigningService } from './wallet-signing.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import { SigningRequestDto, SigningResponseDto } from './dto/signing.dto';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly walletSigningService: WalletSigningService
  ) {}

  @Post()
  create(@Body() createWalletDto: CreateWalletDto) {
    return this.walletsService.create(createWalletDto);
  }

  @Post('create-user-wallet')
  async createUserWallet(@Body() createWalletDto: CreateWalletDto) {
    return await this.walletsService.create(createWalletDto);
  }

  @Get()
  findAll() {
    return this.walletsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.walletsService.findOne(+id);
  }

  @Get('user/:userId')
  findByUserId(@Param('userId') userId: string) {
    return this.walletsService.findByUserId(userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateWalletDto: UpdateWalletDto) {
    return this.walletsService.update(+id, updateWalletDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.walletsService.remove(+id);
  }

  @Post('sign-transaction')
  async signTransaction(@Body() signingRequest: SigningRequestDto): Promise<SigningResponseDto> {
    // Convert base64 transaction to Stellar Transaction object
    const stellar = await import('@stellar/stellar-sdk');
    const xdrTransaction = stellar.TransactionBuilder.fromXDR(signingRequest.transaction, 'base64');
    
    // Ensure we have a regular Transaction, not a FeeBumpTransaction
    const transaction = 'source' in xdrTransaction ? xdrTransaction : xdrTransaction.innerTransaction;
    
    return await this.walletSigningService.signTransaction({
      userId: signingRequest.userId,
      transaction,
    });
  }

  @Get('verify/:userId')
  async verifyWallet(@Param('userId') userId: string) {
    const isValid = await this.walletSigningService.verifyWalletIntegrity(userId);
    return { userId, isValid };
  }
}
