import { BadRequestException } from '@nestjs/common';

export enum MemoType {
  NONE = 'MEMO_NONE',
  TEXT = 'MEMO_TEXT',
  ID = 'MEMO_ID',
  HASH = 'MEMO_HASH',
  RETURN = 'MEMO_RETURN',
}

export interface MemoInput {
  type: MemoType;
  value?: string;
}

const MEMO_TEXT_MAX_BYTES = 28;
const MEMO_ID_MAX = BigInt('18446744073709551615'); // uint64 max
const MEMO_HASH_HEX_LENGTH = 64; // 32 bytes, hex-encoded

/**
 * Validates a Stellar transaction memo against the protocol's per-type constraints:
 * https://developers.stellar.org/docs/encyclopedia/memos
 */
export function validateMemo(memo?: MemoInput): void {
  if (!memo || memo.type === MemoType.NONE) {
    return;
  }

  const { type, value } = memo;

  if (value === undefined || value === '') {
    throw new BadRequestException(`memo.value is required for ${type}`);
  }

  switch (type) {
    case MemoType.TEXT: {
      const byteLength = Buffer.byteLength(value, 'utf8');
      if (byteLength > MEMO_TEXT_MAX_BYTES) {
        throw new BadRequestException(
          `memo of type MEMO_TEXT must be at most ${MEMO_TEXT_MAX_BYTES} bytes, got ${byteLength}`,
        );
      }
      break;
    }

    case MemoType.ID: {
      if (!/^\d+$/.test(value)) {
        throw new BadRequestException(
          'memo of type MEMO_ID must be an unsigned integer string',
        );
      }
      if (BigInt(value) > MEMO_ID_MAX) {
        throw new BadRequestException(
          `memo of type MEMO_ID must not exceed ${MEMO_ID_MAX.toString()}`,
        );
      }
      break;
    }

    case MemoType.HASH:
    case MemoType.RETURN: {
      if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== MEMO_HASH_HEX_LENGTH) {
        throw new BadRequestException(
          `memo of type ${type} must be a ${MEMO_HASH_HEX_LENGTH}-character hex string (32 bytes)`,
        );
      }
      break;
    }

    default:
      throw new BadRequestException(`Unsupported memo type: ${type}`);
  }
}
