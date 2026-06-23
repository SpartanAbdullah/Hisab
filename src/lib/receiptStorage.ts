import { supabase } from './supabase';

// Receipt photos live in a PRIVATE Supabase Storage bucket, keyed under the
// owner's uid folder so RLS can scope access per user. The transaction row
// stores only the object PATH; display uses short-lived signed URLs.
// See supabase-migration-receipts.sql.

const BUCKET = 'receipts';
const MAX_DIM = 1280; // longest side, px — keeps receipts small + readable
const JPEG_QUALITY = 0.7;
const SIGNED_URL_TTL_SECONDS = 60 * 30; // 30 min

function currentUserId(): string {
  const uid = localStorage.getItem('hisaab_supabase_uid');
  if (!uid) throw new Error('Not authenticated');
  return uid;
}

// Pure: the deterministic object path for a transaction's receipt. One receipt
// per transaction — re-uploading overwrites (upsert), so no orphan accrual.
export function receiptPathFor(userId: string, transactionId: string): string {
  return `${userId}/${transactionId}.jpg`;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(file);
  } catch {
    // Fall through to the <img> path (e.g. createImageBitmap unsupported format).
  }
  return await new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Resize/compress an image File to a JPEG Blob bounded by MAX_DIM on its
// longest side. Falls back to the original file if the browser can't decode or
// re-encode it (e.g. some HEIC cases) so capture never hard-fails.
export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await loadBitmap(file);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  return blob ?? file;
}

// Upload (or overwrite) a transaction's receipt. Returns the stored path to
// persist on the transaction row.
export async function uploadReceipt(transactionId: string, file: File): Promise<string> {
  const path = receiptPathFor(currentUserId(), transactionId);
  const blob = await compressImage(file);
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  return path;
}

// Short-lived signed URL for displaying a private receipt. Null when it can't
// be signed (e.g. the object was removed) so the UI can hide gracefully.
export async function getReceiptUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function deleteReceipt(path: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}
