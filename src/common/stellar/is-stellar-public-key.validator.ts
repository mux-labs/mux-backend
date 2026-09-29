import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { StrKey } from 'stellar-sdk';

/**
 * Validates that a property is a well-formed Stellar Ed25519 public key
 * (StrKey "G..." address), using stellar-sdk's checksum validation rather
 * than a bare regex — catches typos/bit-flips that a shape-only check would miss.
 */
export function IsStellarPublicKey(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStellarPublicKey',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          // Uses the SDK's own StrKey implementation, which is the source of
          // truth for the SEP-23 checksum. Never throws on bad input.
          if (typeof value !== 'string') {
            return false;
          }
          try {
            return StrKey.decodeEd25519PublicKey(value) !== null;
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid Stellar public key (StrKey "G..." address)`;
        },
      },
    });
  };
}
