import { describe, it, expect } from 'vitest';
import { receiptPathFor, isImageFile } from './receiptStorage';

describe('receiptPathFor', () => {
  it('keys the object under the owner uid folder', () => {
    expect(receiptPathFor('user-1', 'txn-9')).toBe('user-1/txn-9.jpg');
  });
});

describe('isImageFile', () => {
  it('accepts images and rejects other types', () => {
    expect(isImageFile(new File([''], 'a.jpg', { type: 'image/jpeg' }))).toBe(true);
    expect(isImageFile(new File([''], 'a.png', { type: 'image/png' }))).toBe(true);
    expect(isImageFile(new File([''], 'a.pdf', { type: 'application/pdf' }))).toBe(false);
    expect(isImageFile(new File([''], 'a.txt', { type: '' }))).toBe(false);
  });
});
