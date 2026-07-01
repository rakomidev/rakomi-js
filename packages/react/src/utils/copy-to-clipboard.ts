/**
 * Clipboard copy utility — used by recovery codes, TOTP secret, any copy button.
 * Tries navigator.clipboard first, falls back to execCommand.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
