// Proves each vendored tarball is byte-identical to the artifact npm published
// for that exact name@version.
//
// verify-vendor.mjs deliberately stays offline: it checks the tarball against
// the lockfile integrity. That pair can be regenerated together from a local
// `npm pack`, so a pre-release build can satisfy it while claiming a released
// version. This check is the online counterpart and is CI-only for that reason.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const registry = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";

const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));

const vendored = Object.entries(lock.packages ?? {})
  .filter(([, metadata]) => typeof metadata?.resolved === "string" && metadata.resolved.startsWith("file:vendor/"))
  .map(([path, metadata]) => ({
    name: metadata.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    version: metadata.version,
    relative: metadata.resolved.slice("file:".length),
  }));

assert.ok(vendored.length > 0, "package-lock.json must contain vendored runtime artifacts");

let failures = 0;
for (const { name, version, relative } of vendored) {
  assert.equal(typeof version, "string", `missing version for ${name}`);
  const bytes = await readFile(resolve(root, relative));
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}/${version}`;
  const response = await fetch(url);
  assert.ok(response.ok, `registry lookup failed for ${name}@${version}: ${response.status}`);
  const published = await response.json();
  const expected = published?.dist?.integrity;
  assert.equal(typeof expected, "string", `registry returned no sha512 integrity for ${name}@${version}`);

  if (actual === expected) {
    console.log(`PASS ${relative} matches published ${name}@${version}`);
    continue;
  }
  failures += 1;
  console.error(
    `FAIL ${relative} is not the published ${name}@${version}\n` +
      `  vendored:  ${actual}\n` +
      `  published: ${expected}\n` +
      `  Re-vendor with: npm pack ${name}@${version}`,
  );
}

assert.equal(failures, 0, `${failures} vendored artifact(s) do not match the published release`);
console.log(`PASS ${vendored.length} vendored artifacts match their published releases`);
