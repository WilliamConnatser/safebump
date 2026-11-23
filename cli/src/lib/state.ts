import { mkdirSync, writeFileSync } from "fs";
import path from "path";

// Per-project working files (baselines, progress log, cached migration
// notes) live in <project>/.safebump, which ignores itself in git.
export const stateDir = (projectRoot: string) => {
  const dir = path.join(projectRoot, ".safebump");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".gitignore"), "*\n");
  return dir;
};
