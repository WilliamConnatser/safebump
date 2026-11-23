import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import path from "path";
import semver from "semver";

import { skillDir } from "./paths";
import { stateDir } from "./state";

// Migration notes are the most expensive context to produce and identical
// for every project doing the same upgrade, so they're cached:
//   - bundled with the skill: references/migrations/<pkg>/<from>-to-<to>.md
//     (curated, promoted after successful eval runs)
//   - per project: .safebump/migrations/<pkg>/<from>-to-<to>.md
//     (written after research, reused across sessions)
// <from>/<to> are major versions.

const bundledDir = () => path.join(skillDir(), "references", "migrations");

const slug = (pkg: string) => pkg.replace(/^@/, "").replace(/\//g, "__");

export type NoteFile = {
  path: string;
  source: "bundled" | "project";
  from: number;
  to: number;
  // whether this note covers part of the requested from→to range
  relevant: boolean;
};

const majorOf = (v?: string) => {
  const c = v ? semver.coerce(v) : null;
  return c ? c.major : undefined;
};

export const findNotes = (
  projectRoot: string,
  pkg: string,
  from?: string,
  to?: string,
): NoteFile[] => {
  const fromMajor = majorOf(from);
  const toMajor = majorOf(to);
  const dirs: [string, NoteFile["source"]][] = [
    [path.join(projectRoot, ".safebump", "migrations", slug(pkg)), "project"],
    [path.join(bundledDir(), slug(pkg)), "bundled"],
  ];
  const found: NoteFile[] = [];
  for (const [dir, source] of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const m = /^(\d+)-to-(\d+)\.md$/.exec(file);
      if (!m) continue;
      const a = Number(m[1]);
      const b = Number(m[2]);
      const relevant =
        fromMajor === undefined || toMajor === undefined
          ? true
          : a >= fromMajor && b <= toMajor;
      found.push({ path: path.join(dir, file), source, from: a, to: b, relevant });
    }
  }
  return found.sort((x, y) => x.from - y.from);
};

export const saveNote = (
  projectRoot: string,
  pkg: string,
  from: string,
  to: string,
  file: string,
) => {
  const a = majorOf(from);
  const b = majorOf(to);
  if (a === undefined || b === undefined) {
    throw new Error(`Can't read major versions from '${from}' and '${to}'`);
  }
  const dir = path.join(stateDir(projectRoot), "migrations", slug(pkg));
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${a}-to-${b}.md`);
  copyFileSync(file, target);
  return target;
};

export const printNotes = (notes: NoteFile[], pkg: string) => {
  const relevant = notes.filter((n) => n.relevant);
  if (relevant.length === 0) {
    console.log(
      `No cached migration notes for ${pkg}. Research it, then save the result with: safebump notes save ${pkg} <from> <to> <file>`,
    );
    return;
  }
  for (const n of relevant) {
    console.log(`\n# ${pkg} ${n.from} → ${n.to} (${n.source}: ${n.path})\n`);
    console.log(readFileSync(n.path, "utf-8").trim());
  }
};
