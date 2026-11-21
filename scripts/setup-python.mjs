import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const venvDir = resolve(root, ".venv");

function getVenvBin(name, winExt = ".exe") {
  if (isWindows) {
    const directPath = resolve(venvDir, "Scripts", `${name}${winExt}`);
    if (existsSync(directPath)) return directPath;
    const noExtPath = resolve(venvDir, "Scripts", name);
    if (existsSync(noExtPath)) return noExtPath;
    return directPath;
  }
  return resolve(venvDir, "bin", name);
}

const wadecryptBin = getVenvBin("wadecrypt");
const venvPythonBin = isWindows
  ? (existsSync(resolve(venvDir, "Scripts", "python.exe"))
      ? resolve(venvDir, "Scripts", "python.exe")
      : resolve(venvDir, "Scripts", "python"))
  : (existsSync(resolve(venvDir, "bin", "python3"))
      ? resolve(venvDir, "bin", "python3")
      : resolve(venvDir, "bin", "python"));
const venvPipBin = getVenvBin("pip");

// 1. Skip if already set up
if (existsSync(wadecryptBin)) {
  console.log("✔ Python virtual environment and wa-crypt-tools are ready.");
  process.exit(0);
}

// 2. Locate host Python executable across Windows, macOS, and Linux
const pythonCandidates = isWindows
  ? ["python", "py -3", "py", "python3"]
  : ["python3", "python"];
let hostPythonCmd = null;
let hostPythonArgs = [];

for (const candidate of pythonCandidates) {
  const parts = candidate.split(" ");
  const bin = parts[0];
  const args = parts.slice(1);
  try {
    const check = spawnSync(bin, [...args, "--version"], { stdio: "ignore" });
    if (check.status === 0) {
      hostPythonCmd = bin;
      hostPythonArgs = args;
      break;
    }
  } catch {
    // ignore lookup error
  }
}

if (!hostPythonCmd) {
  console.warn(
    "⚠️  Warning: Python 3 was not found in PATH.\n" +
      "Please install Python 3 and wa-crypt-tools manually if you plan to decrypt backups.",
  );
  process.exit(0);
}

// 3. Create .venv if missing or broken (e.g. missing python binary)
if (!existsSync(venvDir) || !existsSync(venvPythonBin)) {
  if (existsSync(venvDir)) {
    try {
      rmSync(venvDir, { recursive: true, force: true });
    } catch {
      // ignore removal error
    }
  }

  console.log("📦 Creating Python virtual environment in .venv...");
  const venvResult = spawnSync(
    hostPythonCmd,
    [...hostPythonArgs, "-m", "venv", ".venv"],
    {
      cwd: root,
      stdio: "inherit",
    },
  );

  if (venvResult.status !== 0 || !existsSync(venvPythonBin)) {
    console.error("❌ Failed to create virtual environment.");
    if (process.platform === "linux") {
      console.error(
        "💡 Hint: On Debian/Ubuntu systems, install the venv package first:\n" +
          "   sudo apt install -y python3-venv python3-pip",
      );
    }
    process.exit(0);
  }
}

// 4. Ensure pip is present in the virtual environment
let pipAvailable = existsSync(venvPipBin);

if (!pipAvailable) {
  // Check if python -m pip works in venv
  const testPipModule = spawnSync(
    venvPythonBin,
    ["-m", "pip", "--version"],
    { stdio: "ignore" },
  );

  if (testPipModule.status === 0) {
    pipAvailable = true;
  }
}

if (!pipAvailable) {
  console.log("📦 Pip was not found in .venv, attempting to bootstrap with ensurepip...");
  const ensureResult = spawnSync(
    venvPythonBin,
    ["-m", "ensurepip", "--upgrade"],
    { cwd: root, stdio: "inherit" },
  );

  if (ensureResult.status === 0) {
    pipAvailable = true;
  }
}

if (!pipAvailable) {
  console.log("📦 Attempting to bootstrap pip via get-pip.py...");
  try {
    const res = await fetch("https://bootstrap.pypa.io/get-pip.py");
    if (res.ok) {
      const scriptCode = await res.text();
      const tempScript = resolve(tmpdir(), `get-pip-${Date.now()}.py`);
      writeFileSync(tempScript, scriptCode, "utf8");

      const bootstrapResult = spawnSync(
        venvPythonBin,
        [tempScript, "--no-setuptools", "--no-wheel"],
        { cwd: root, stdio: "inherit" },
      );

      try {
        rmSync(tempScript, { force: true });
      } catch {
        // ignore cleanup error
      }

      if (bootstrapResult.status === 0) {
        pipAvailable = true;
      }
    }
  } catch (err) {
    console.warn("⚠️  Could not download get-pip.py automatically:", err.message);
  }
}

// 5. Install wa-crypt-tools into .venv
if (pipAvailable) {
  console.log("📦 Installing wa-crypt-tools into .venv...");
  const installResult = spawnSync(
    venvPythonBin,
    ["-m", "pip", "install", "--upgrade", "wa-crypt-tools"],
    { cwd: root, stdio: "inherit" },
  );

  if (installResult.status === 0 && existsSync(wadecryptBin)) {
    console.log("✔ wa-crypt-tools installed successfully.");
    process.exit(0);
  }
}

// 6. Handle failure with helpful platform-specific troubleshooting
console.error("\n❌ Failed to automatically set up wa-crypt-tools in .venv.");
if (process.platform === "linux") {
  console.error(
    "💡 On Debian or Ubuntu, Python packages venv and pip separately. Install them with:\n" +
      "   sudo apt install -y python3-venv python3-pip\n" +
      "   rm -rf .venv\n" +
      "   bun scripts/setup-python.mjs\n",
  );
} else if (process.platform === "darwin") {
  console.error(
    "💡 On macOS, make sure Python 3 is installed (e.g. via Homebrew or python.org):\n" +
      "   brew install python3\n" +
      "   bun scripts/setup-python.mjs\n",
  );
} else {
  console.error(
    "💡 On Windows, ensure Python 3 is installed from python.org with 'Add Python to PATH' checked.\n" +
      "   Then run: pip install wa-crypt-tools\n",
  );
}
