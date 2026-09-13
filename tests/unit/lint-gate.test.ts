import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

function lint(source: string, filename: string) {
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "run", "lint", "--", "--stdin", "--stdin-filename", filename
  ], { cwd: root, input: source, encoding: "utf8", timeout: 30_000 });
}

describe("the local and CI correctness lint gate", () => {
  it("parses maintained TypeScript rather than silently ignoring it", () => {
    const result = lint("export const accepted: boolean = true;\n", "packages/server/src/lint-probe.ts");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails a duplicate switch case in maintained TypeScript", () => {
    const result = lint('export function choose(value: number) { switch (value) { case 1: return "first"; case 1: return "second"; } }\n', "packages/server/src/lint-probe.ts");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("no-duplicate-case");
  });
});
