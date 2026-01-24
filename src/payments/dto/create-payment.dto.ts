export class CreatePaymentDto {
    fromId: number;
    toId: number;
    amount: number;
    currency: string;
    description?: string;
}
