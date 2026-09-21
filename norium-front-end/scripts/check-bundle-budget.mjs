import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const distRoot = fileURLToPath(new URL("../dist", import.meta.url));
const limits = { ".js": 500_000, ".css": 400_000 };
const ignored = [/pdf\.worker/i];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

const failures = [];
for (const file of await filesBelow(distRoot)) {
  if (ignored.some((pattern) => pattern.test(file))) continue;
  const extension = Object.keys(limits).find((candidate) => file.endsWith(candidate));
  if (!extension) continue;
  const size = (await stat(file)).size;
  const relativePath = relative(distRoot, file);
  const limit = extension === ".js" && relativePath.includes("realtime-vendor-")
    ? 520_000
    : limits[extension];
  if (size > limit) {
    failures.push(`${relativePath}: ${size} bytes > ${limit} bytes`);
  }
}

if (failures.length) {
  console.error(`Bundle budget exceeded:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Bundle budget passed: JS <= 500 KB (LiveKit <= 520 KB) and CSS <= 400 KB.");
}
