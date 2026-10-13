import clipboardy from "clipboardy";
import { spawn } from "node:child_process";

function copyViaXclip(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn("xclip", ["-selection", "clipboard"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
      proc.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copies plain text to the system clipboard across OSes (macOS, Windows, Linux, WSL).
 * Uses native xclip on Linux when available to prevent daemon drop-outs, falling back to clipboardy.
 * Fails gracefully if no display/clipboard daemon is available in headless environments.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform === "linux") {
    const xclipSuccess = await copyViaXclip(text);
    if (xclipSuccess) return true;
  }

  try {
    await clipboardy.write(text);
    return true;
  } catch {
    return false;
  }
}
