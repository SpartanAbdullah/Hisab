// Deliver a generated PDF (or any Blob) to the user's share targets, one code
// path per runtime:
//   - Native (Capacitor Android): write the file to the Cache dir via
//     @capacitor/filesystem, then open the OS share sheet via @capacitor/share
//     with the file URI. The user picks WhatsApp → the contact.
//   - Web with Web Share Level 2: navigator.share({ files }) when the browser
//     reports it can share files.
//   - Anything else: download the file (blob URL anchor), same as dataExport.
//
// wa.me links can only carry text, so a PDF cannot ride the reminder deep link —
// this native/Web-Share path is the only way to attach the actual document.

import { isNativeRuntime } from './runtime';

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled' | 'error';

export interface ShareFileInput {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string; // optional caption sent alongside the file
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function shareNative(input: ShareFileInput): Promise<ShareOutcome> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  const data = await blobToBase64(input.blob);
  const write = await Filesystem.writeFile({
    path: input.filename,
    data,
    directory: Directory.Cache,
    recursive: true,
  });
  let uri = write?.uri;
  if (!uri) {
    const got = await Filesystem.getUri({ path: input.filename, directory: Directory.Cache });
    uri = got.uri;
  }

  try {
    await Share.share({
      title: input.title,
      text: input.text,
      url: uri,
      dialogTitle: input.title,
    });
    return 'shared';
  } catch (err) {
    // The Share plugin rejects when the user dismisses the sheet.
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (message.includes('cancel') || message.includes('abort') || message.includes('dismiss')) {
      return 'cancelled';
    }
    throw err;
  }
}

async function shareWeb(input: ShareFileInput): Promise<ShareOutcome> {
  const file = new File([input.blob], input.filename, { type: input.blob.type || 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: input.title, text: input.text });
      return 'shared';
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
      // Fall through to download on any non-abort failure.
    }
  }
  downloadBlob(input.blob, input.filename);
  return 'downloaded';
}

export async function shareStatementFile(input: ShareFileInput): Promise<ShareOutcome> {
  try {
    return isNativeRuntime() ? await shareNative(input) : await shareWeb(input);
  } catch {
    // Last-ditch: never leave the user empty-handed — try a plain download.
    try {
      downloadBlob(input.blob, input.filename);
      return 'downloaded';
    } catch {
      return 'error';
    }
  }
}
