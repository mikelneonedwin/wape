import { input, select } from "@inquirer/prompts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pc from "picocolors";
import {
  getAppConfig,
  getWapeConfigFile,
  getWapeDir,
  saveAppConfig,
} from "./wape-store";

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
 * Scans directories (Downloads, user home, ~/.wape or WAPE_HOME) for rogue WhatsApp mgstore backup files matching:
 * "mgstore" -> optional content -> "db" -> optional content -> "crypt" -> optional content (case-insensitive).
 * Also accepts "msgstore" variation.
 */
export function discoverMsgstoreBackups(): string[] {
  const candidateDirs = [join(homedir(), "Downloads"), homedir(), getWapeDir()];

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
            if (
              stats.isFile() &&
              stats.size > 0 &&
              !discoveredMap.has(fullPath)
            ) {
              discoveredMap.set(fullPath, fullPath);
            }
          } catch (_err) {
            // Ignore unreadable candidate file
          }
        }
      }
    } catch (_err) {
      // Ignore unreadable directory
    }
  }

  return Array.from(discoveredMap.values());
}

/**
 * Backward-compatible single discovery helper
 */
export function discoverMsgstoreBackup(): string | null {
  const all = discoverMsgstoreBackups();
  return all.length > 0 ? (all[0] ?? null) : null;
}

/**
 * Resolves the backup path and decryption key from options, WAPE_BACKUP / WAPE_KEY env vars, config.json, or auto-discovery with interactive selection.
 */
export async function resolveBackupCredentials(options?: {
  backupPath?: string;
  backupKey?: string;
}): Promise<{ backupPath: string; backupKey?: string }> {
  const appConfig = getAppConfig();

  // 1. Resolve Backup Path
  let backupPath =
    options?.backupPath ?? process.env.WAPE_BACKUP ?? appConfig.backupPath;

  if (!backupPath || !existsSync(backupPath)) {
    const discoveredList = discoverMsgstoreBackups();

    if (discoveredList.length === 1) {
      const discovered = discoveredList[0];
      console.log(
        pc.cyan(
          `🔎 Discovered WhatsApp backup file at: ${pc.bold(discovered)}`,
        ),
      );
      backupPath = discovered;
    } else if (discoveredList.length > 1) {
      console.log(
        pc.cyan(
          `\n🔎 Discovered ${discoveredList.length} WhatsApp backup files:\n`,
        ),
      );
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
      `WhatsApp backup database not found. Provide a path via '--backup <path>', set WAPE_BACKUP env, or set 'backupPath' in ${getWapeConfigFile()}, or place your msgstore.db.crypt* file in ~/Downloads, ~, or ${getWapeDir()}.`,
    );
  }

  // 2. Resolve Decryption Key
  const backupKey =
    options?.backupKey ??
    process.env.WAPE_KEY ??
    process.env.WAPE_DECRYPTION_KEY ??
    appConfig.key;

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
  saveKeyToConfig?: boolean;
}): Promise<string> {
  const { backupPath, backupKey } = await resolveBackupCredentials(options);

  // If already an unencrypted SQLite database, use it directly
  if (isSqliteDatabase(backupPath)) {
    return backupPath;
  }

  let key = backupKey;

  if (!key) {
    console.log(
      pc.yellow(
        `\n🔑 WhatsApp backup decryption key is required for:\n${pc.bold(backupPath)}\n`,
      ),
    );
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
    if (options?.saveKeyToConfig !== false) {
      saveAppConfig({ key });
      console.log(
        pc.green(`✅ Decryption key saved to ${getWapeConfigFile()}\n`),
      );
    }
  }

  // Generate a distinct cache filename in OS temp directory
  const stats = statSync(backupPath);
  const hash = createHash("sha256")
    .update(`${backupPath}:${stats.size}:${stats.mtimeMs}:${key}`)
    .digest("hex")
    .slice(0, 12);

  const outputPath = options?.customOutputPath
    ? resolve(options.customOutputPath)
    : join(tmpdir(), `wape_msgstore_${hash}.db`);

  // Check if decrypted file already exists, is valid, and matches cache
  if (
    existsSync(outputPath) &&
    statSync(outputPath).size > 0 &&
    isSqliteDatabase(outputPath)
  ) {
    return outputPath;
  }

  const projectRoot = resolve(import.meta.dir, "../../");
  const candidateWadecrypt = [
    resolve(projectRoot, ".venv/bin/wadecrypt"),
    resolve(projectRoot, ".venv/Scripts/wadecrypt.exe"),
    resolve(projectRoot, ".venv/Scripts/wadecrypt"),
  ];
  const candidatePython = [
    resolve(projectRoot, ".venv/bin/python3"),
    resolve(projectRoot, ".venv/bin/python"),
    resolve(projectRoot, ".venv/Scripts/python.exe"),
    resolve(projectRoot, ".venv/Scripts/python"),
  ];

  const foundWadecrypt = candidateWadecrypt.find((p) => existsSync(p));
  const foundPython = candidatePython.find((p) => existsSync(p));

  function runProcess(
    cmd: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((res) => {
      const child = spawn(cmd, args);
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        res({ exitCode: code ?? 0, stdout, stderr });
      });

      child.on("error", (err) => {
        res({ exitCode: 1, stdout, stderr: err.message });
      });
    });
  }

  let result: { exitCode: number; stdout: string; stderr: string } | null =
    null;

  if (foundWadecrypt) {
    result = await runProcess(foundWadecrypt, [key, backupPath, outputPath]);
  } else if (foundPython) {
    result = await runProcess(foundPython, [
      "-m",
      "wa_crypt_tools.wadecrypt",
      key,
      backupPath,
      outputPath,
    ]);
  } else {
    // Fallback to global wadecrypt / python3 / python / py
    const globalCommands: [string, string[]][] = [
      ["wadecrypt", [key, backupPath, outputPath]],
      [
        "python3",
        ["-m", "wa_crypt_tools.wadecrypt", key, backupPath, outputPath],
      ],
      [
        "python",
        ["-m", "wa_crypt_tools.wadecrypt", key, backupPath, outputPath],
      ],
      ["py", ["-m", "wa_crypt_tools.wadecrypt", key, backupPath, outputPath]],
    ];

    let lastError: unknown;
    for (const [cmd, args] of globalCommands) {
      try {
        result = await runProcess(cmd, args);
        if (result.exitCode === 0) {
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!result) {
      throw new Error(
        `Failed to find or execute wadecrypt / python. Ensure python and wa-crypt-tools are installed in .venv or on your PATH: ${String(lastError)}`,
      );
    }
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `Decryption failed with exit code ${result.exitCode}.\nStdout: ${result.stdout}\nStderr: ${result.stderr}`,
    );
  }

  if (
    !existsSync(outputPath) ||
    statSync(outputPath).size === 0 ||
    !isSqliteDatabase(outputPath)
  ) {
    throw new Error(
      `Decrypted output file was not generated or is invalid at: ${outputPath}`,
    );
  }

  return outputPath;
}
