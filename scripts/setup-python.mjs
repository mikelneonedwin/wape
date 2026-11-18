import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const venvDir = resolve(root, ".venv");
const wadecryptBin = isWindows
  ? resolve(venvDir, "Scripts", "wadecrypt.exe")
  : resolve(venvDir, "bin", "wadecrypt");
const pipBin = isWindows
  ? resolve(venvDir, "Scripts", "pip.exe")
  : resolve(venvDir, "bin", "pip");

// 1. Skip if already set up
if (existsSync(wadecryptBin)) {
  console.log("✔ Python virtual environment and wa-crypt-tools are ready.");
  process.exit(0);
}

// 2. Locate host Python executable
const pythonCandidates = isWindows
  ? ["python", "py", "python3"]
  : ["python3", "python"];
let hostPython = null;

for (const cmd of pythonCandidates) {
  try {
    const check = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    if (check.status === 0) {
      hostPython = cmd;
      break;
    }
  } catch {
    // ignore lookup error
  }
}

if (!hostPython) {
  console.warn(
    "⚠️  Warning: Python 3 was not found in PATH. Skipping .venv setup for wa-crypt-tools.\nPlease install Python 3 and wa-crypt-tools manually if you plan to decrypt backups.",
  );
  process.exit(0);
}

// 3. Create .venv if missing
if (!existsSync(venvDir)) {
  console.log("📦 Creating Python virtual environment in .venv...");
  const venvResult = spawnSync(hostPython, ["-m", "venv", ".venv"], {
    cwd: root,
    stdio: "inherit",
  });
  if (venvResult.status !== 0) {
    console.error("❌ Failed to create virtual environment.");
    process.exit(0);
  }
}

// 4. Install wa-crypt-tools into .venv
console.log("📦 Installing wa-crypt-tools into .venv...");
const installResult = spawnSync(pipBin, ["install", "wa-crypt-tools"], {
  cwd: root,
  stdio: "inherit",
});

if (installResult.status === 0) {
  console.log("✔ wa-crypt-tools installed successfully.");
} else {
  console.error(
    "❌ Failed to install wa-crypt-tools into .venv. You can install it manually by activating .venv and running: pip install wa-crypt-tools",
  );
}
