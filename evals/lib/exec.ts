import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
};

export type ExecOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** append a header, stdout and stderr to this file */
  log?: string;
  input?: string;
};

/**
 * Runs a command without a shell (pass ["bash", "-c", ...] for one). The child
 * gets its own process group so a timeout kills everything it spawned.
 */
export const run = (
  cmd: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> =>
  new Promise((resolve) => {
    const started = Date.now();
    if (opts.log) {
      appendFileSync(
        opts.log,
        `\n$ ${[cmd, ...args].map(quote).join(" ")}  (cwd ${opts.cwd})\n`,
      );
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const onData = (which: "out" | "err") => (d: Buffer) => {
      const s = d.toString();
      if (which === "out") stdout += s;
      else stderr += s;
      if (opts.log) appendFileSync(opts.log, s);
    };
    child.stdout!.on("data", onData("out"));
    child.stderr!.on("data", onData("err"));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 10_000).unref();
      } catch {
        /* already gone */
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const finish = (code: number | null) => {
      if (timer) clearTimeout(timer);
      const ms = Date.now() - started;
      if (opts.log) {
        appendFileSync(
          opts.log,
          `\n[exit ${code}${timedOut ? ", timed out" : ""}, ${(ms / 1000).toFixed(1)}s]\n`,
        );
      }
      resolve({ code, stdout, stderr, timedOut, ms });
    };
    child.on("error", (e) => {
      stderr += String(e);
      finish(127);
    });
    child.on("close", finish);
  });

export const sh = (script: string, opts: ExecOptions) =>
  run("bash", ["-c", script], opts);

export const quote = (s: string) =>
  /^[\w@%+=:,./^~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export const which = async (bin: string) =>
  (await sh(`command -v ${quote(bin)}`, { cwd: process.cwd() })).code === 0;
