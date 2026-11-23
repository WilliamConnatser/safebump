// Builds the published skill's CLI: a minified, self-contained ESM bundle
// in skills/safebump/scripts/, so installing the skill copies no sources,
// no package.json and needs no `npm install`. Code loaded only in AI mode
// (the AI SDK and its providers, via dynamic import) is split into
// scripts/chunks/, so deterministic commands never load it. Also writes the
// license files the skill folder needs when it's copied into someone's repo
// on its own.
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const skill = path.join(repo, "skills", "safebump");
const outdir = path.join(skill, "scripts");
const outfile = path.join(outdir, "safebump.mjs");
const chunkDir = path.join(outdir, "chunks");

const version = /^\s+version:\s*"([^"]+)"/m.exec(readFileSync(path.join(skill, "SKILL.md"), "utf-8"))?.[1];
if (!version) throw new Error("SKILL.md has no metadata.version");

// chunk names carry content hashes: drop the previous build's
rmSync(chunkDir, { recursive: true, force: true });

const result = await build({
  entryPoints: { safebump: path.join(here, "src", "cli.ts") },
  outdir,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  // node builtins esbuild 0.25 doesn't list as such
  external: ["readline/promises"],
  target: "node20",
  format: "esm",
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  banner: {
    js: [
      `// safebump ${version}. MIT License; see LICENSE in the skill folder. Bundled third-party code: see THIRD_PARTY_NOTICES.md there.`,
      // bundled CommonJS dependencies (typescript, ts-morph) call require
      `import { createRequire as __safebumpCreateRequire } from "module"; const require = __safebumpCreateRequire(import.meta.url);`,
      // ...and read __filename/__dirname, which ES modules don't define
      `import { fileURLToPath as __safebumpFileURLToPath } from "url"; import { dirname as __safebumpDirname } from "path"; const __filename = __safebumpFileURLToPath(import.meta.url); const __dirname = __safebumpDirname(__filename);`,
    ].join("\n"),
  },
});

// third-party notices for exactly the packages that ended up in the bundle
// or any of its chunks (the metafile's inputs cover every output)
const packageRoot = (input) => {
  const parts = input.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i === -1) return undefined;
  const len = parts[i + 1]?.startsWith("@") ? 3 : 2;
  return path.join(here, ...parts.slice(0, i + len));
};
const roots = new Set(
  Object.keys(result.metafile.inputs).map(packageRoot).filter((r) => r && existsSync(path.join(r, "package.json"))),
);
const notices = Array.from(roots)
  .map((root) => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
    const licenseFile = readdirSync(root).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
    const text = licenseFile ? readFileSync(path.join(root, licenseFile), "utf-8").trim() : `License: ${pkg.license ?? "unknown"} (no license file shipped)`;
    return { name: pkg.name, version: pkg.version, license: pkg.license ?? "unknown", text };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// @ts-morph/common embeds its own copy of the TypeScript compiler
// (dist/typescript.js), which is Apache-2.0: ship TypeScript's license and
// third-party notice with it
if (notices.some((n) => n.name === "@ts-morph/common")) {
  const tsDir = path.join(here, "node_modules", "typescript");
  const tsPkg = JSON.parse(readFileSync(path.join(tsDir, "package.json"), "utf-8"));
  const embedded = /versionMajorMinor = "([^"]+)"/.exec(
    readFileSync(path.join(here, "node_modules", "@ts-morph", "common", "dist", "typescript.js"), "utf-8"),
  )?.[1];
  notices.push({
    name: "typescript",
    version: `${embedded ?? tsPkg.version} (embedded in @ts-morph/common)`,
    license: tsPkg.license,
    text: [
      readFileSync(path.join(tsDir, "LICENSE.txt"), "utf-8").trim(),
      readFileSync(path.join(tsDir, "ThirdPartyNoticeText.txt"), "utf-8").trim(),
    ].join("\n\n"),
  });
}

writeFileSync(
  path.join(skill, "THIRD_PARTY_NOTICES.md"),
  [
    "# Third-party notices",
    "",
    "`scripts/safebump.mjs` and `scripts/chunks/` bundle the following packages. Their licenses are reproduced below.",
    "",
    ...notices.map((n) => `- ${n.name}@${n.version} (${n.license})`),
    "",
    ...notices.flatMap((n) => [`## ${n.name}@${n.version}`, "", "```", n.text, "```", ""]),
  ].join("\n"),
);

// the skill is copied into other repos without the repo root
copyFileSync(path.join(repo, "LICENSE"), path.join(skill, "LICENSE"));

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const outputs = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith(".mjs"));
const mainKey = path.relative(process.cwd(), outfile).split(path.sep).join("/");
const main = result.metafile.outputs[mainKey];
// what a deterministic command loads: the entry plus its static imports
const loaded = new Set();
const visit = (f) => {
  if (loaded.has(f)) return;
  loaded.add(f);
  for (const i of result.metafile.outputs[f]?.imports ?? []) if (i.kind === "import-statement" && !i.external) visit(i.path);
};
visit(mainKey);
const sum = (files) => files.reduce((n, f) => n + result.metafile.outputs[f].bytes, 0);
console.log(
  `built ${path.relative(repo, outfile)} (${kb(main?.bytes ?? statSync(outfile).size)}; ${kb(sum([...loaded]))} loaded by deterministic commands) + ${outputs.length - 1} AI-mode chunks (${kb(sum(outputs.map(([f]) => f).filter((f) => !loaded.has(f))))}) with ${notices.length} bundled packages: ${notices.map((n) => n.name).join(", ")}`,
);
