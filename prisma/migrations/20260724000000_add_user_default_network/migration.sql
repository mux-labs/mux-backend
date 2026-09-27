-- AlterTable: add defaultNetwork preference to User
ALTER TABLE "User" ADD COLUMN "defaultNetwork" "WalletNetwork";
