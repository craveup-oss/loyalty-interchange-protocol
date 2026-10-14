import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker health check routing", () => {
  it.each([
    ["development", "", "/live", "3210"],
    ["development", "10000", "/live", "10000"],
    ["production", "", "/health", "3210"],
    ["sandbox", "", "/health", "3210"],
    ["", "", "/health", "3210"]
  ])("probes %s with port %s", (environment, overridePort, path, port) => {
    const directory = mkdtempSync(join(tmpdir(), "loyalty-healthcheck-"));
    try {
      const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
      const healthcheck = dockerfile.slice(dockerfile.indexOf("HEALTHCHECK"));
      const command = healthcheck.match(/\n\s*CMD ([\s\S]*?)\n\nCMD /)![1]!.replace(/\\\n\s*/g, " ");
      const argsFile = join(directory, "arguments");
      writeFileSync(join(directory, "wget"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PROBE_ARGS_FILE"\n', { mode: 0o700 });
      execFileSync("/bin/sh", ["-c", command], { env: {
        ...process.env, PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        PROBE_ARGS_FILE: argsFile, LIP_CLOUD_DEPLOYMENT_ENVIRONMENT: environment, HEALTH_PORT: overridePort
      } });
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
        "-qO-", `http://127.0.0.1:${port}${path}`
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
