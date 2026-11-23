import { spawn } from "child_process";

export const run = (command: string, options: { cwd: string }) => {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, { cwd: options.cwd, shell: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    },
  );
};
