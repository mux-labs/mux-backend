export class SigningRequestDto {
  userId: string;
  transaction: string; // Base64 encoded Stellar transaction
}

export class SigningResponseDto {
  signedTransaction: string;
  success: boolean;
  error?: string;
}
