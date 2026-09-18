import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

function ensureEnvLoaded() {
  if (process.env.WHATSAPP_BACKUP_PATH && process.env.WHATSAPP_BACKUP_KEY) {
    return;
  }

  const candidateFiles = [
    join(process.cwd(), ".env"),
    join(homedir(), "workspace/wa-extractor/.env"),
    join(homedir(), ".wape/.env"),
  ];

  for (const filePath of candidateFiles) {
    if (existsSync(filePath)) {
      try {
        const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
            const eqIndex = trimmed.indexOf("=");
            const key = trimmed.slice(0, eqIndex).trim();
            const val = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {}
    }
  }
}

ensureEnvLoaded();

export const env = createEnv({
  server: {
    WHATSAPP_BACKUP_PATH: z.string().min(1, "WHATSAPP_BACKUP_PATH is required"),
    WHATSAPP_BACKUP_KEY: z.string().min(1, "WHATSAPP_BACKUP_KEY is required"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
