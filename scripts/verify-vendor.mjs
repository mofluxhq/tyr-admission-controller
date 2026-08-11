import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));

const vendored = Object.entries(lock.packages ?? {})
  .map(([name, metadata]) => ({ name, metadata }))
  .filter(({ metadata }) => typeof metadata?.resolved === "string" && metadata.resolved.startsWith("file:vendor/"));

assert.ok(vendored.length > 0, "package-lock.json must contain vendored runtime artifacts");

for (const { name, metadata } of vendored) {
  const relative = metadata.resolved.slice("file:".length);
  const path = resolve(root, relative);
  const bytes = await readFile(path).catch((error) => {
    throw new Error(`missing vendored artifact for ${name}: ${relative}`, { cause: error });
  });
  const expected = metadata.integrity;
  assert.equal(typeof expected, "string", `missing integrity for ${name}`);
  assert.ok(expected.startsWith("sha512-"), `unsupported integrity for ${name}: ${expected}`);
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(actual, expected, `integrity mismatch for ${relative}`);
  console.log(`PASS ${relative} ${bytes.length} bytes`);
}

const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
assert.match(dockerfile, /COPY\s+vendor\s+\.\/vendor/, "Dockerfile must copy vendor/ before npm ci");
console.log(`PASS Dockerfile copies vendor/ (${vendored.length} artifacts verified)`);
