import { describe, it, expect } from 'vitest';
import {
  RECEIPT_MAX_BYTES,
  checkReceiptUpload,
  receiptPathFor,
} from './receiptStorage';

// Pure-function coverage only, per the repo's testing philosophy: the upload
// itself talks to Supabase Storage and is verified by hand.
describe('checkReceiptUpload', () => {
  it('allows the four types the bucket allowlist carries', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(checkReceiptUpload(1024, mime)).toBeNull();
    }
  });

  it('rejects everything else, including the HEIC fallback case', () => {
    expect(checkReceiptUpload(1024, 'image/heic')).toBe('BAD_TYPE');
    expect(checkReceiptUpload(1024, 'image/gif')).toBe('BAD_TYPE');
    expect(checkReceiptUpload(1024, '')).toBe('BAD_TYPE');
    expect(checkReceiptUpload(1024, null)).toBe('BAD_TYPE');
    expect(checkReceiptUpload(1024, undefined)).toBe('BAD_TYPE');
  });

  it('normalises case and a charset parameter', () => {
    expect(checkReceiptUpload(1024, 'IMAGE/JPEG')).toBeNull();
    expect(checkReceiptUpload(1024, 'image/png; charset=binary')).toBeNull();
  });

  it('enforces the 5 MiB bucket cap exactly', () => {
    expect(checkReceiptUpload(RECEIPT_MAX_BYTES, 'image/jpeg')).toBeNull();
    expect(checkReceiptUpload(RECEIPT_MAX_BYTES + 1, 'image/jpeg')).toBe('TOO_LARGE');
  });

  it('reports a bad type before a bad size, so the message is the actionable one', () => {
    expect(checkReceiptUpload(RECEIPT_MAX_BYTES * 4, 'image/heic')).toBe('BAD_TYPE');
  });
});

describe('receiptPathFor', () => {
  it('is one stable path per transaction so re-upload overwrites', () => {
    expect(receiptPathFor('uid-1', 'txn-9')).toBe('uid-1/txn-9.jpg');
    expect(receiptPathFor('uid-1', 'txn-9')).toBe(receiptPathFor('uid-1', 'txn-9'));
  });
});
