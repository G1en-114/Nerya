// Prepare once, then give the native bundler the private runtime library paths.
// A beforeBuildCommand child cannot change its parent Tauri process environment.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(desktop, "node_modules/@tauri-apps/cli/tauri.js");

export function nativeTarget(args, host, envTarget = "") {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const index = flags.findIndex(arg => arg === "--target" || arg === "-t");
  const value = flags.find(arg => arg.startsWith("--target="));
  const target = index >= 0 ? flags[index + 1] : value?.slice("--target=".length) || envTarget || host;
  if (!host || !target || target !== host)
    throw new Error(`Build on the native target (${host || "unknown"}); requested ${target || "missing"}.`);
  return target;
}

export function bundlerEnvironment(runtime, manifest, platform, inherited = {}) {
  const env = { ...inherited };
  if (platform !== "linux") return env;
  if (typeof manifest.python !== "string" || path.isAbsolute(manifest.python))
    throw new Error("Bundled Python must use a relative resource path.");
  const base = path.resolve(runtime);
  const python = path.resolve(base, manifest.python);
  if (!python.startsWith(base + path.sep)) throw new Error("Bundled Python escapes the runtime.");
  const library = path.resolve(path.dirname(python), "../lib");
  if (!library.startsWith(base + path.sep) || !fs.statSync(library).isDirectory()
      || !fs.realpathSync(library).startsWith(fs.realpathSync(base) + path.sep))
    throw new Error("Portable Python private libraries are missing or outside the runtime.");
  // _tkinter needs the distribution's libtcl/libtk, not an unrelated system Tcl.
  // This search path is build-only: payload checks launch in a clean environment.
  env.LD_LIBRARY_PATH = [library, inherited.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  return env;
}

export function tauriBuildArguments(args) {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const cargo = separator < 0 ? [] : args.slice(separator);
  return ["build", "--features", "custom-protocol", ...flags,
    "--config", JSON.stringify({ build: { beforeBuildCommand: null } }), ...cargo];
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: desktop, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status ?? result.signal}`);
}

export function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    run(process.execPath, [cli, "build", "--help"], process.env);
    return;
  }
  const rust = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (rust.error || rust.status !== 0) throw new Error("Install the native Rust toolchain before building the desktop app.");
  const host = /^host:\s*(\S+)/m.exec(rust.stdout)?.[1];
  const target = nativeTarget(args, host, process.env.CARGO_BUILD_TARGET);
  run(process.execPath, [path.join(desktop, "scripts/prepare.mjs")],
    { ...process.env, TAURI_ENV_TARGET_TRIPLE: target });
  const runtime = path.join(desktop, "runtime");
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"));
  if (manifest.dev !== false || manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("Refusing to bundle a development or foreign-architecture runtime.");
  run(process.execPath, [cli, ...tauriBuildArguments(args)],
    bundlerEnvironment(runtime, manifest, process.platform, process.env));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
