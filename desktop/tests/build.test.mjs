import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeTarget, bundlerEnvironment, tauriBuildArguments } from "../scripts/build.mjs";

test("only native runtime targets can be packaged", () => {
  const host = "x86_64-unknown-linux-gnu";
  assert.equal(nativeTarget([], host), host);
  assert.equal(nativeTarget(["--target", host], host), host);
  assert.equal(nativeTarget(["-t", host], host), host);
  assert.equal(nativeTarget([`--target=${host}`], host), host);
  for (const flags of [["--target"], ["--target", "aarch64-apple-darwin"], ["-t", "aarch64-apple-darwin"], ["--target=universal-apple-darwin"]])
    assert.throws(() => nativeTarget(flags, host), /native target/);
  assert.throws(() => nativeTarget([], host, "x86_64-pc-windows-msvc"), /native target/);
});

test("Python's real private library directory is available to linuxdeploy", () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "nerya-build-path-"));
  try {
    const lib = path.join(runtime, "python", "recorded-distribution", "lib");
    fs.mkdirSync(lib, { recursive: true });
    const manifest = { python: "python/recorded-distribution/bin/python3" };
    const inherited = { LD_LIBRARY_PATH: "/existing/libs", EXAMPLE: "keep" };
    const env = bundlerEnvironment(runtime, manifest, "linux", inherited);
    assert.equal(env.LD_LIBRARY_PATH, lib + path.delimiter + "/existing/libs");
    assert.equal(env.EXAMPLE, "keep");
    assert.equal(inherited.LD_LIBRARY_PATH, "/existing/libs");
    assert.equal(bundlerEnvironment(runtime, manifest, "linux").LD_LIBRARY_PATH, lib);
    assert.deepEqual(bundlerEnvironment(runtime, {}, "darwin", inherited), inherited);
    assert.deepEqual(bundlerEnvironment(runtime, {}, "win32", inherited), inherited);
    for (const python of ["../outside/bin/python3", path.resolve(runtime, "outside"), null])
      assert.throws(() => bundlerEnvironment(runtime, { python }, "linux"));
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
});

test("preparation runs once without swallowing Cargo flags", () => {
  const args = tauriBuildArguments(["--ci", "--bundles", "deb,appimage", "--", "--locked"]);
  const marker = args.indexOf("--");
  assert.deepEqual(args.slice(marker), ["--", "--locked"]);
  assert.equal(JSON.parse(args[args.indexOf("--config") + 1]).build.beforeBuildCommand, null);
  assert.ok(args.indexOf("--config") < marker);
  assert.ok(args.includes("custom-protocol"));
});
