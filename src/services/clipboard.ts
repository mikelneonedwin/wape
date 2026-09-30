import clipboardy from "clipboardy";

/**
 * Copies plain text to the system clipboard across OSes (macOS, Windows, Linux, WSL).
 * Fails gracefully if no display/clipboard daemon is available in headless environments.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await clipboardy.write(text);
    return true;
  } catch {
    return false;
  }
}
