import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalRequest } from "../../../../lib/requestLocality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parsePort(raw: string | null | undefined, fallback: number): number {
  const value = Number(String(raw || "").trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      {
        ok: false,
        error: "local_only",
        detail: "System restart is only available from a local dashboard session.",
      },
      { status: 403 },
    );
  }

  const dashboardDir = process.cwd();
  const repoRoot = path.resolve(dashboardDir, "..");
  const projectRoot = path.resolve(repoRoot, "..");
  const windowsScript = path.join(repoRoot, "scripts", "windows", "start-local.ps1");
  const posixScript = path.join(projectRoot, "start-demo-services.command");
  const scriptPath = process.platform === "win32" ? windowsScript : posixScript;
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json(
      {
        ok: false,
        error: "restart_script_missing",
        detail: `Cannot find restart script: ${scriptPath}`,
      },
      { status: 500 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const workspace =
    typeof body.workspace === "string" && body.workspace.trim()
      ? body.workspace.trim()
      : path.join(os.homedir(), ".nerya");
  const apiPort = parsePort(
    typeof body.apiPort === "number" || typeof body.apiPort === "string"
      ? String(body.apiPort)
      : null,
    18317,
  );
  const hasDashboardPort =
    typeof body.dashboardPort === "number" || typeof body.dashboardPort === "string";
  const dashboardPort = hasDashboardPort
    ? parsePort(String(body.dashboardPort), 18380)
    : parsePort(req.nextUrl.port, 18380);

  const child = process.platform === "win32"
    ? spawn(
        "pwsh",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Start-Sleep -Seconds 2; & '${scriptPath.replace(/'/g, "''")}' ` +
            `-Workspace '${workspace.replace(/'/g, "''")}' ` +
            `-ApiPort ${apiPort} -DashboardPort ${dashboardPort}`,
        ],
        {
          cwd: repoRoot,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      )
    : spawn(
        "/bin/bash",
        ["-lc", 'sleep 2; exec /bin/bash "$NERYA_RESTART_SCRIPT" restart --no-open'],
        {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            NERYA_RESTART_SCRIPT: scriptPath,
            NERYA_DEMO_WORKSPACE: workspace,
            NERYA_DEMO_API_PORT: String(apiPort),
            NERYA_DEMO_DASHBOARD_PORT: String(dashboardPort),
            NERYA_DEMO_NO_OPEN: "1",
          },
        },
      );
  child.unref();

  return NextResponse.json({
    ok: true,
    status: "queued",
    workspace,
    apiPort,
    dashboardPort,
  });
}
