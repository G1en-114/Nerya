import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { copyStandalone, unlinkBuildSymlinks } from "./standalone.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktop, "..");
const dashboard = path.join(root, "dashboard");
const destination = path.join(desktop, "runtime");
const dev = process.argv.includes("--dev");
const requireDashboard = createRequire(path.join(dashboard, "package.json"));
const nextCli = requireDashboard.resolve("next/dist/bin/next");

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: desktop, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status})`);
}
async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${url} (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function copyFilter(source) {
  const name = path.basename(source);
  return name !== "__pycache__" && name !== ".DS_Store" && name !== ".env" && !name.startsWith(".env.");
}
async function main() {
  run(process.execPath, [path.join(desktop, "node_modules/@tauri-apps/cli/tauri.js"), "icon",
    path.join(dashboard, "public/branding/Logo.png"), "--output", path.join(desktop, "src-tauri/icons")]);
  if (dev) {
    const python = process.env.NERYA_DESKTOP_PYTHON || path.join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    if (!existsSync(python)) throw new Error("Create agent/.venv with Nerya installed, or set NERYA_DESKTOP_PYTHON.");
    run(python, ["-c", "import sys; assert sys.version_info >= (3, 10); import nerya"], { cwd: root });
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(path.join(desktop, "runtime_host.py"), path.join(destination, "runtime_host.py"));
    await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify({
      dev: true, python, node: process.execPath, dashboard, next_cli: nextCli,
      python_paths: [root, path.join(root, "sdk/python")],
    }, null, 2));
    console.log("Nerya desktop development runtime is ready.");
    return;
  }
  // All packaging is native-target. Never silently bundle host binaries into another target.
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || "";
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const targetOS = { darwin: "apple-darwin", linux: "linux", win32: "windows" }[process.platform];
  if (!arch || (target && (!target.startsWith(arch) || !target.includes(targetOS))))
    throw new Error("Build on the target OS and architecture; cross-target runtime packaging is unsupported.");
  const stage = path.join(desktop, `.runtime-build-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  const pythonVersion = process.env.NERYA_PYTHON_VERSION || "3.12.13";
  const uv = process.env.UV || "uv";
  // Build-owned cache avoids changing or relying on the user's global cache permissions.
  const uvOptions = { env: { ...process.env, UV_CACHE_DIR: path.join(desktop, ".runtime-build-uv-cache") } };
  const pythonDir = path.join(stage, "python");
  run(uv, ["python", "install", pythonVersion, "--install-dir", pythonDir, "--no-bin", "--no-config"], uvOptions);
  // uv also creates a minor-version symlink; ship the exact, real distribution.
  const installations = (await fs.readdir(pythonDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`cpython-${pythonVersion}-`))
    .map(entry => entry.name);
  if (installations.length !== 1) throw new Error("Expected one portable Python distribution.");
  // uv's top-level minor-version aliases point into the temporary install directory.
  // The manifest uses the exact distribution, so omit these build-only aliases.
  for (const entry of await fs.readdir(pythonDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) await fs.unlink(path.join(pythonDir, entry.name));
  }
  const pythonRel = path.join("python", installations[0], process.platform === "win32" ? "python.exe" : "bin/python3");
  const python = path.join(stage, pythonRel);
  // Build from a clean, curated source tree: setuptools must not resurrect deleted
  // modules from a developer's stale build/lib directory. No tests or workspaces ship.
  const source = path.join(desktop, `.runtime-build-source-${randomUUID()}`);
  await fs.mkdir(source, { recursive: true });
  for (const name of ["pyproject.toml", "README.md", "nerya", "sdk/python"]) {
    await fs.cp(path.join(root, name), path.join(source, name), { recursive: true, filter: copyFilter });
  }
  run(uv, ["pip", "install", "--python", python, "--target", path.join(stage, "packages"),
    `${source}[mcp,trading,prediction,browser]`], uvOptions);
  const browser = path.join(stage, "browser");
  run(python, ["-m", "playwright", "install", "chromium"], { env: {
    ...process.env, PYTHONPATH: path.join(stage, "packages"), PYTHONNOUSERSITE: "1",
    PLAYWRIGHT_BROWSERS_PATH: browser, PLAYWRIGHT_SKIP_BROWSER_GC: "1",
  } });
  if (existsSync(path.join(stage, "packages/nerya/workspace/bootstrap.py")))
    throw new Error("Refusing to package legacy strategy seeding code.");
  // Include playbooks, prompt bundles and wallet JS templates, not just Python modules.
  await fs.cp(path.join(root, "nerya"), path.join(stage, "app/nerya"), { recursive: true, filter: copyFilter });
  await fs.cp(path.join(root, "sdk/python/nerya_sdk"), path.join(stage, "app/nerya_sdk"), { recursive: true, filter: copyFilter });

  // Do NOT copy Homebrew's Node executable: it depends on Homebrew dylibs.
  // Fetch the portable official distribution and verify its published checksum.
  const nodeVersion = process.env.NERYA_NODE_VERSION || process.versions.node;
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error("NERYA_NODE_VERSION must be an exact x.y.z version.");
  const nodePlatform = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
  if (!nodePlatform) throw new Error("Unsupported desktop OS.");
  const nodeName = `node-v${nodeVersion}-${nodePlatform}-${process.arch}`;
  const archiveName = `${nodeName}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const dist = `https://nodejs.org/dist/v${nodeVersion}`;
  const checksums = await fetch(`${dist}/SHASUMS256.txt`).then(response => {
    if (!response.ok) throw new Error("Cannot retrieve Node checksums.");
    return response.text();
  });
  const expected = checksums.split("\n").find(line => line.trim().endsWith(` ${archiveName}`))?.trim().split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Node artifact has no published checksum.");
  const archive = path.join(stage, archiveName);
  await download(`${dist}/${archiveName}`, archive);
  if (await sha256(archive) !== expected) throw new Error("Node checksum mismatch.");
  run("tar", ["-xf", archive, "-C", stage]);
  const nodeRel = path.join(nodeName, process.platform === "win32" ? "node.exe" : "bin/node");

  const distDir = ".next-desktop-build";
  // Next 14's recursive cleaner follows symlinked directories. Only unlink
  // build-output links, never traverse a source/dependency/workspace target.
  await unlinkBuildSymlinks(path.join(dashboard,distDir));
  run(process.execPath, [nextCli, "build"], { cwd: dashboard, env: {
    ...process.env, NERYA_DESKTOP_BUILD: "1", NERYA_UI_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1",
  } });
  await copyStandalone(path.join(dashboard, distDir), path.join(stage, "web"));
  const webRel = existsSync(path.join(stage, "web/dashboard/server.js")) ? "web/dashboard" : "web";
  if (!existsSync(path.join(stage, webRel, "server.js"))) throw new Error("Next standalone server.js was not generated.");
  await fs.cp(path.join(dashboard, distDir, "static"), path.join(stage, webRel, distDir, "static"), { recursive: true });
  await fs.cp(path.join(dashboard, "public"), path.join(stage, webRel, "public"), { recursive: true, filter: copyFilter });
  await fs.copyFile(path.join(desktop, "runtime_host.py"), path.join(stage, "runtime_host.py"));
  await fs.writeFile(path.join(stage, "manifest.json"), JSON.stringify({
    dev: false, python: pythonRel, node: nodeRel, dashboard: webRel, browser: "browser", python_paths: ["app", "packages"],
    python_version: pythonVersion, node_version: nodeVersion, node_sha256: expected,
    platform: process.platform, arch: process.arch,
  }, null, 2));
  // Keep licenses shipped by the Python, Node and dependency distributions.
  // Only these build-owned directories are replaced; no workspace/user data is touched.
  await fs.rm(archive);
  if (existsSync(destination)) await fs.rename(destination, path.join(desktop, `.runtime-build-previous-${randomUUID()}`));
  await fs.rename(stage, destination);
  console.log("Nerya desktop runtime packaged: portable Python + Node + Next standalone.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
