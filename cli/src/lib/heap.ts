import { spawnSync } from "child_process";
import { getHeapStatistics } from "v8";

// AST analysis of large monorepos (deprecations, defaults) needs more than
// Node's default heap. Relaunch once with a bigger one rather than asking
// every caller to set NODE_OPTIONS. SAFEBUMP_MAX_HEAP_MB overrides (0
// disables), and an explicit --max-old-space-size always wins.
export const ensureHeap = () => {
  if (process.env.SAFEBUMP_HEAP_SET) return;
  const wanted = Number(process.env.SAFEBUMP_MAX_HEAP_MB ?? 8192);
  const explicit = /--max-old-space-size/.test(
    `${process.env.NODE_OPTIONS ?? ""} ${process.execArgv.join(" ")}`,
  );
  const currentMb = getHeapStatistics().heap_size_limit / 1024 / 1024;
  if (!wanted || explicit || currentMb >= wanted * 0.9) return;

  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${wanted}`, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, SAFEBUMP_HEAP_SET: "1" } },
  );
  process.exit(result.status ?? (result.signal ? 1 : 0));
};
