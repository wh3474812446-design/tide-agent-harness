import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const extensions = new Set([".ts", ".tsx", ".js"]);
const ignored = new Set([".git", "node_modules", "dist", "vendor"]);
const totals = { files: 0, lines: 0, bytes: 0 };
const byTopLevel = new Map();

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
      continue;
    }
    if (!extensions.has(path.extname(entry.name))) continue;

    const content = await readFile(fullPath, "utf8");
    const metadata = await stat(fullPath);
    const lines = content.split(/\r?\n/).length;
    const relative = path.relative(root, fullPath);
    const topLevel = relative.split(path.sep)[0] ?? "(root)";
    const area = byTopLevel.get(topLevel) ?? { files: 0, lines: 0, bytes: 0 };

    totals.files += 1;
    totals.lines += lines;
    totals.bytes += metadata.size;
    area.files += 1;
    area.lines += lines;
    area.bytes += metadata.size;
    byTopLevel.set(topLevel, area);
  }
}

await walk(root);
const areas = [...byTopLevel.entries()]
  .map(([area, value]) => ({ area, ...value }))
  .sort((a, b) => b.lines - a.lines);

console.log(JSON.stringify({ root, totals, areas }, null, 2));

