// Native, mount-free DMG creation for local builds and headless CI. No Finder,
// DiskArbitration detach, security setting changes or global disk operations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function macBundlePlan(args, platform) {
  if (platform !== "darwin") return { args, dmg: false };
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const cargo = separator < 0 ? [] : args.slice(separator);
  if (flags.includes("--no-bundle")) return { args, dmg: false };
  const retained = [];
  const formats = [];
  let selected = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--bundles" || flag === "-b") {
      selected = true;
      const begin = i + 1;
      while (i + 1 < flags.length && !flags[i + 1].startsWith("-")) formats.push(...flags[++i].split(","));
      if (i < begin) throw new Error("Missing macOS bundle format.");
    } else if (flag.startsWith("--bundles=") || flag.startsWith("-b=")) {
      selected = true;
      formats.push(...flag.slice(flag.indexOf("=") + 1).split(","));
    } else retained.push(flag);
  }
  if (!selected) formats.push("app", "dmg");
  if (formats.some(value => !["app", "dmg", "all"].includes(value)))
    throw new Error(`Unsupported native macOS bundle formats: ${formats.join(",")}`);
  const dmg = formats.includes("dmg") || formats.includes("all");
  return { args: [...retained, "--bundles", "app", ...cargo], dmg };
}

export function macBundleDirectory(args, env = process.env) {
  const flags = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  const index = flags.findIndex(arg => arg === "--target" || arg === "-t");
  const target = index >= 0 ? flags[index + 1] : flags.find(arg => arg.startsWith("--target="))?.slice(9) || env.CARGO_BUILD_TARGET;
  const directory = env.CARGO_TARGET_DIR ? path.resolve(desktop, env.CARGO_TARGET_DIR) : path.join(desktop, "src-tauri/target");
  return path.join(directory, target || "", flags.includes("--debug") || flags.includes("-d") ? "debug" : "release", "bundle");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 900000 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${path.basename(command)} failed: ${result.status}`);
}

export function createDiskImage(bundle = path.join(desktop, "src-tauri/target/release/bundle")) {
  if (process.platform !== "darwin") throw new Error("Create the disk image on native macOS.");
  const config = JSON.parse(fs.readFileSync(path.join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  const app = path.join(bundle, "macos", `${config.productName}.app`);
  if (!fs.statSync(app).isDirectory()) throw new Error("The signed application bundle is missing.");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const output = path.join(bundle, "dmg");
  fs.mkdirSync(output, { recursive: true });
  const stage = fs.mkdtempSync(path.join(output, ".dmg-source-"));
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
  const target = path.join(output, `${config.productName}_${config.version}_${architecture}.dmg`);
  try {
    run("/usr/bin/ditto", [app, path.join(stage, path.basename(app))]);
    fs.symlinkSync("/Applications", path.join(stage, "Applications"));
    run("/usr/bin/hdiutil", ["create", "-ov", "-volname", config.productName,
      "-srcfolder", stage, "-format", "UDZO", target]);
    run("/usr/bin/hdiutil", ["verify", target]);
    console.log(`Verified mount-free disk image: ${target}`);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { createDiskImage(); } catch (error) { console.error(error); process.exitCode = 1; }
}
