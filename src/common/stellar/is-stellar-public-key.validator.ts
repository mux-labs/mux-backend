import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { StrKeyHelper } from '../../key-management/utils';

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
        validate(value: unknown, _args: ValidationArguments) {
          return (
            typeof value === 'string' &&
            StrKeyHelper.isValidEd25519PublicKey(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid Stellar public key (StrKey "G..." address)`;
        },
      },
    });
  };
}
