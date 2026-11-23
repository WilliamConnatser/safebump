import { existsSync, readFileSync } from "fs";
import path from "path";
import { Project, ts } from "ts-morph";

// tsconfig.json may be a solution file ("files": [] plus "references"),
// common in monorepos and Vite templates
export const tsconfigReferences = (projectRoot: string) => {
  const file = path.join(projectRoot, "tsconfig.json");
  if (!existsSync(file)) return [];
  const { config } = ts.parseConfigFileTextToJson(
    file,
    readFileSync(file, "utf-8"),
  ) as { config?: { references?: { path: string }[] } };
  return (config?.references ?? []).map((ref) => {
    const target = path.resolve(projectRoot, ref.path);
    return target.endsWith(".json")
      ? target
      : path.join(target, "tsconfig.json");
  });
};

// ts-morph is only used for structure (blocks, imports, references) and
// declaration text, so its bundled TypeScript doesn't need to match the
// project's checker
export const initializeAst = (projectRoot: string) => {
  const project = new Project({
    tsConfigFilePath: path.join(projectRoot, "tsconfig.json"),
  });
  for (const ref of tsconfigReferences(projectRoot)) {
    if (existsSync(ref)) project.addSourceFilesFromTsConfig(ref);
  }
  return project;
};
