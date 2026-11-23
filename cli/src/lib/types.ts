export type BuildError = {
  // relative to the project root, as tsc prints it
  path: string;
  line: number;
  column: number;
  message: string;
};

export type PackageUpgrade = {
  packageName: string;
  newVersion: string;
};
