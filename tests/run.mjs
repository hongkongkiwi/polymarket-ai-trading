import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require("esbuild");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  esbuild = createRequire(require.resolve("vite"))("esbuild");
}

const directory = await mkdtemp(join(tmpdir(), "polymarket-deployment-tests-"));
try {
  const outfile = join(directory, "deployment.test.mjs");
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL(process.argv[2] ?? "./deployment.test.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
  });
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", outfile], {
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
