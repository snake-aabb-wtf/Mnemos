import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const consoleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(consoleRoot, "../..");
const node = process.execPath;
const children = [];

function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
  children.push(child);
  return child;
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitFor(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch { /* process is still starting */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const server = start(node, ["apps/server/dist/index.js"], repoRoot);
const viteEntry = resolve(consoleRoot, "node_modules/vite/bin/vite.js");
if (!existsSync(viteEntry)) throw new Error(`Vite entry not found: ${viteEntry}`);
const vite = start(node, [viteEntry, "--host", "127.0.0.1", "--port", "5173"], consoleRoot);

let exitCode = 1;
try {
  await waitFor("http://127.0.0.1:4317/api/v1/health");
  await waitFor("http://127.0.0.1:5173/");
  const playwrightEntry = resolve(consoleRoot, "node_modules/@playwright/test/cli.js");
  const runner = spawn(node, [playwrightEntry, "test"], { cwd: consoleRoot, stdio: ["inherit", "pipe", "pipe"], env: process.env });
  children.push(runner);
  let output = "";
  const forward = (chunk) => { const text = String(chunk); output += text; process.stdout.write(text); };
  runner.stdout?.on("data", forward);
  runner.stderr?.on("data", forward);
  exitCode = await new Promise((resolvePromise) => {
    const cleanupTimer = setTimeout(() => {
      const passed = /\b\d+ passed\b/.test(output) && !/\b\d+ failed\b/.test(output);
      runner.kill();
      if (process.platform === "win32" && runner.pid) spawn("taskkill", ["/pid", String(runner.pid), "/t", "/f"], { stdio: "ignore" });
      resolvePromise(passed ? 0 : 1);
    }, 10_000);
    runner.once("error", () => { clearTimeout(cleanupTimer); resolvePromise(1); });
    runner.once("exit", (code) => { clearTimeout(cleanupTimer); resolvePromise(code ?? 1); });
  });
} finally {
  stop(server);
  stop(vite);
}

process.exit(exitCode);
