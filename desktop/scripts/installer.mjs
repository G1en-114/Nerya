// macOS Installer package; end users do not run npm, Python, Rust or a shell.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Use the native Tauri installer on Windows/Linux.");
const configuration = JSON.parse(await fs.readFile(path.join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
const app = path.join(desktop, "src-tauri/target/release/bundle/macos/Nerya.app");
await fs.access(path.join(app, "Contents/MacOS/nerya-desktop"));
// A linker-only signature does not bind the app's identity or resources.
const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", app], { stdio: "inherit" });
if (verified.error || verified.status !== 0) throw verified.error || new Error("Refusing to package an app with an invalid bundle signature.");
const output = path.join(desktop, "src-tauri/target/release/bundle/pkg");
await fs.mkdir(output, { recursive: true });
const plist = path.join(output, "components.plist");
await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>Nerya.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>`);
const target = path.join(output, `Nerya-${configuration.version}-${process.arch}.pkg`);
const result = spawnSync("/usr/bin/pkgbuild", ["--root", path.dirname(app), "--component-plist", plist,
  "--install-location", "/Applications", "--identifier", configuration.identifier,
  "--version", configuration.version.split("-")[0], target], { stdio: "inherit" });
if (result.error || result.status !== 0) throw result.error || new Error(`pkgbuild failed: ${result.status}`);
console.log(`Installer created: ${target}`);
