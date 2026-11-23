import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { readPackageJson } from "./packages";

// npm/yarn/bun declare workspaces in package.json, pnpm in pnpm-workspace.yaml
const workspacePatterns = (dir: string): string[] | undefined => {
  const pnpmFile = path.join(dir, "pnpm-workspace.yaml");
  if (existsSync(pnpmFile)) {
    const lines = readFileSync(pnpmFile, "utf-8").split("\n");
    const patterns: string[] = [];
    let inPackages = false;
    for (const line of lines) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const item = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
        if (item?.[1]) patterns.push(item[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
    return patterns;
  }
  const workspaces = (readPackageJson(dir) as { workspaces?: unknown } | undefined)
    ?.workspaces;
  if (Array.isArray(workspaces)) return workspaces as string[];
  if (workspaces && typeof workspaces === "object") {
    return ((workspaces as { packages?: string[] }).packages ?? []) as string[];
  }
  return undefined;
};

export const findWorkspaceRoot = (projectRoot: string) => {
  let dir = projectRoot;
  while (true) {
    if (workspacePatterns(dir)) return dir;
    if (existsSync(path.join(dir, ".git"))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".turbo"]);

// supports the glob forms workspaces use in practice: literal segments,
// "*" and "**"
const expand = (root: string, pattern: string): string[] => {
  const segments = pattern.replace(/^\.\//, "").replace(/\/$/, "").split("/");
  let dirs = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (segment === "**") {
        const walk = (d: string, depth: number) => {
          next.push(d);
          if (depth >= 4) return;
          for (const child of safeChildren(d)) walk(child, depth + 1);
        };
        walk(dir, 0);
      } else if (segment.includes("*")) {
        const re = new RegExp(
          `^${segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
        );
        next.push(...safeChildren(dir).filter((c) => re.test(path.basename(c))));
      } else {
        const child = path.join(dir, segment);
        if (existsSync(child)) next.push(child);
      }
    }
    dirs = next;
  }
  return dirs.filter((d) => existsSync(path.join(d, "package.json")));
};

const safeChildren = (dir: string) => {
  try {
    return readdirSync(dir)
      .filter((name) => !IGNORED.has(name))
      .map((name) => path.join(dir, name))
      .filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
};

export type Workspace = {
  name?: string;
  dir: string;
  relPath: string;
  hasTsconfig: boolean;
  dependencies: Record<string, string>;
};

export const listWorkspaces = (projectRoot: string): Workspace[] => {
  const root = findWorkspaceRoot(projectRoot) ?? projectRoot;
  const patterns = workspacePatterns(root) ?? [];
  const excluded = new Set(
    patterns
      .filter((p) => p.startsWith("!"))
      .flatMap((p) => expand(root, p.slice(1))),
  );
  const dirs = new Set([
    root,
    ...patterns
      .filter((p) => !p.startsWith("!"))
      .flatMap((p) => expand(root, p))
      .filter((d) => !excluded.has(d)),
  ]);

  return Array.from(dirs).map((dir) => {
    const pkg = readPackageJson(dir) as
      | {
          name?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        }
      | undefined;
    return {
      name: pkg?.name,
      dir,
      relPath: path.relative(root, dir) || ".",
      hasTsconfig: existsSync(path.join(dir, "tsconfig.json")),
      dependencies: { ...pkg?.devDependencies, ...pkg?.dependencies },
    };
  });
};

export const workspacesUsing = (projectRoot: string, pkgs: string[]) =>
  listWorkspaces(projectRoot).filter((w) =>
    pkgs.some((p) => p in w.dependencies),
  );
