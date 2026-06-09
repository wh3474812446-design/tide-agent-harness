#!/usr/bin/env node
// Tide 启动器：用本地 tsx 运行 src/cli.ts，把当前目录作为工作区。
// 跨平台：直接用 node 跑 tsx 的 cli.mjs，避免 Windows 上 spawn .cmd 的限制。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

if (!existsSync(tsxCli)) {
  console.error(`找不到 tsx，请先在 Tide 目录运行 npm install：\n  ${root}`);
  process.exit(1);
}

const child = spawn(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`无法启动 Tide：${err.message}`);
  process.exit(1);
});
