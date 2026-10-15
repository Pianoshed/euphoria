// Saving and sharing for the Android app. The Android WebView has no <a download> and no navigator.share,
// so inside the app we use Capacitor's Filesystem + Share plugins. In a normal browser the old web way is used.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNative = () => Capacitor.isNativePlatform();

// Use this to decide whether to show a "Share" button.
export const canShareAny = () => isNative() || (typeof navigator !== 'undefined' && !!navigator.share);

// True when the person tapped "cancel" on the share sheet (not a real error).
export const isShareCancel = (e) => e?.name === 'AbortError' || /cancel|abort|dismiss/i.test(String(e?.message || ''));

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function writeTo(directory, blob, name) {
  const res = await Filesystem.writeFile({ path: name, data: await toBase64(blob), directory, recursive: true });
  return res.uri;
}

// Saves a copy to the phone (Documents folder in the app). Returns true if it was saved without opening anything.
export async function saveBlob(blob, name) {
  if (isNative()) {
    try {
      await writeTo(Directory.Documents, blob, name);
      return true;
    } catch {
      // No permission for Documents on this phone: open the share sheet so the person can still save it.
      const uri = await writeTo(Directory.Cache, blob, name);
      await Share.share({ title: name, url: uri, dialogTitle: 'Save or share' });
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

// Can this file be shared from here?
export const canShareFile = (file) => isNative() || !!navigator.canShare?.({ files: [file] });

// Opens the share sheet with a picture/file. Throws on cancel (check isShareCancel).
export async function shareFile(blob, name, { title, text } = {}) {
  if (isNative()) {
    const uri = await writeTo(Directory.Cache, blob, name);
    await Share.share({ title, text, url: uri, dialogTitle: title });
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  await navigator.share({ files: [file], title, text });
}

// Opens the share sheet with text and/or a link.
export async function shareText({ title, text, url }) {
  if (isNative()) {
    await Share.share({ title, text, url, dialogTitle: title });
    return;
  }
  await navigator.share({ title, text, url });
}
