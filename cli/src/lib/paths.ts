import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The skill folder (SKILL.md, assets/, references/). The code runs from the
// bundle in <skill>/scripts/ when installed, and from cli/src/ in
// development, so look for it instead of assuming a depth.
let cached: string | undefined;
export const skillDir = () => {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(dir, "SKILL.md"))) return (cached = dir);
    const dev = path.join(dir, "skills", "safebump");
    if (existsSync(path.join(dev, "SKILL.md"))) return (cached = dev);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Can't find the safebump skill folder (SKILL.md).");
    dir = parent;
  }
};
