import { input, select } from "@inquirer/prompts";
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import pc from "picocolors";
import { getAppConfig, getWapeDir, saveAppConfig } from "./wape-store";

/**
 * Checks if a file is already an unencrypted SQLite database by inspecting its header magic bytes.
 */
export function isSqliteDatabase(filePath: string): boolean {
  try {
    const fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(16);
    readSync(fd, buffer, 0, 16, 0);
    closeSync(fd);
    return buffer.toString("utf-8") === "SQLite format 3\0";
  } catch {
    return false;
  }
}

/**
 * Scans directories (Downloads, user home, ~/.wape) for rogue WhatsApp mgstore backup files matching:
 * "mgstore" -> optional content -> "db" -> optional content -> "crypt" -> optional content (case-insensitive).
 * Also accepts "msgstore" variation.
 */
export function discoverMsgstoreBackups(): string[] {
  const candidateDirs = [
    join(homedir(), "Downloads"),
    homedir(),
    getWapeDir(),
  ];

  const pattern = /m[sg]?gstore.*db.*crypt.*/i;
  const discoveredMap = new Map<string, string>();

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (pattern.test(entry)) {
          const fullPath = join(dir, entry);
          try {
            const stats = statSync(fullPath);
            if (stats.isFile() && stats.size > 0 && !discoveredMap.has(fullPath)) {
              discoveredMap.set(fullPath, fullPath);
            }
          } catch {}
        }
      }
    } catch {}
  }

  return Array.from(discoveredMap.values());
}

/**
 * Backward-compatible single discovery helper
 */
export function discoverMsgstoreBackup(): string | null {
  const all = discoverMsgstoreBackups();
  return all.length > 0 ? all[0] : null;
}

/**
 * Resolves the backup path and decryption key from options, ~/.wape/config.json, or auto-discovery with interactive selection.
 */
export async function resolveBackupCredentials(options?: {
  backupPath?: string;
  backupKey?: string;
}): Promise<{ backupPath: string; backupKey?: string }> {
  let appConfig = getAppConfig();

  // 1. Resolve Backup Path
  let backupPath = options?.backupPath ?? appConfig.backupPath;

  if (!backupPath || !existsSync(backupPath)) {
    const discoveredList = discoverMsgstoreBackups();

    if (discoveredList.length === 1) {
      const discovered = discoveredList[0];
      console.log(pc.cyan(`🔎 Discovered WhatsApp backup file at: ${pc.bold(discovered)}`));
      backupPath = discovered;
    } else if (discoveredList.length > 1) {
      console.log(pc.cyan(`\n🔎 Discovered ${discoveredList.length} WhatsApp backup files:\n`));
      const picked = await select<string>({
        message: "Select WhatsApp backup file to use:",
        choices: discoveredList.map((path) => {
          const stats = statSync(path);
          const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
          return {
            name: `${pc.bold(basename(path))} ${pc.dim(`(${sizeMb} MB • ${path})`)}`,
            value: path,
          };
        }),
      });

      backupPath = picked;
      console.log(pc.green(`✅ Using backup file: ${pc.bold(picked)}\n`));
    }
  }

  if (!backupPath || !existsSync(backupPath)) {
    throw new Error(
      `WhatsApp backup database not found. Provide a path via '--backup <path>' or set 'backupPath' in ~/.wape/config.json, or place your msgstore.db.crypt* file in ~/Downloads, ~, or ~/.wape.`
    );
  }

  // 2. Resolve Decryption Key
  const backupKey = options?.backupKey ?? appConfig.key ?? process.env.WHATSAPP_BACKUP_KEY;

  return {
    backupPath: resolve(backupPath),
    backupKey: backupKey?.trim(),
  };
}

/**
 * Ensures the target WhatsApp backup is available as a readable SQLite database.
 * If the backup is already an unencrypted SQLite file, it returns the path directly.
 * If encrypted (.crypt15, .crypt14, .crypt12, etc.), it decrypts it via wa-crypt-tools.
 */
export async function ensureDecryptedDatabase(options?: {
  backupPath?: string;
  backupKey?: string;
  customOutputPath?: string;
}): Promise<string> {
  const { backupPath, backupKey } = await resolveBackupCredentials(options);

  // If already an unencrypted SQLite database, use it directly
  if (isSqliteDatabase(backupPath)) {
    return backupPath;
  }

  let key = backupKey;

  if (!key) {
    console.log(pc.yellow(`\n🔑 WhatsApp backup decryption key is required for:\n${pc.bold(backupPath)}\n`));
    key = await input({
      message: "Enter your 64-character WhatsApp decryption key (hex string):",
      validate: (val) => {
        const trimmed = val.trim();
        if (!trimmed) return "Decryption key cannot be empty.";
        if (trimmed.length !== 64 && !existsSync(trimmed)) {
          return "The key should either be a 64-character hex string or a path to a key file.";
        }
        return true;
      },
    });

    key = key.trim();
    saveAppConfig({ key });
    console.log(pc.green(`✅ Decryption key saved to ~/.wape/config.json\n`));
  }

  // Generate a distinct cache filename in ~/.wape/
  const stats = statSync(backupPath);
  const hash = createHash("sha256")
    .update(`${backupPath}:${stats.size}:${stats.mtimeMs}:${key}`)
    .digest("hex")
    .slice(0, 12);

  const outputPath = options?.customOutputPath
    ? resolve(options.customOutputPath)
    : join(getWapeDir(), `cache_msgstore_${hash}.db`);

  // Check if decrypted file already exists, is valid, and matches cache
  if (existsSync(outputPath) && statSync(outputPath).size > 0 && isSqliteDatabase(outputPath)) {
    return outputPath;
  }

  const venvPython = resolve("/home/winner/workspace/wa-extractor/.venv/bin/python3");
  const venvWadecrypt = resolve("/home/winner/workspace/wa-extractor/.venv/bin/wadecrypt");

  let proc;
  if (existsSync(venvWadecrypt)) {
    proc = Bun.spawn([venvWadecrypt, key, backupPath, outputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } else if (existsSync(venvPython)) {
    proc = Bun.spawn([venvPython, "-m", "wa_crypt_tools.wadecrypt", key, backupPath, outputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } else {
    // Fallback to global wadecrypt / python
    proc = Bun.spawn(["wadecrypt", key, backupPath, outputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    throw new Error(
      `Decryption failed with exit code ${exitCode}.\nStdout: ${stdout}\nStderr: ${stderr}`
    );
  }

  if (!existsSync(outputPath) || statSync(outputPath).size === 0 || !isSqliteDatabase(outputPath)) {
    throw new Error(`Decrypted output file was not generated or is invalid at: ${outputPath}`);
  }

  return outputPath;
}
