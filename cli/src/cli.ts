import path from "path";
import { parseArgs } from "util";

import type { ApiReport, ErrorAnalysis } from "./lib/typescript/analyze";
import {
  analyzeErrors,
  describeApi,
  findReferences,
} from "./lib/typescript/analyze";
import { getBuildErrors, resolveChecker } from "./lib/checker";
import { ensureHeap } from "./lib/heap";
import {
  applyUpgrades,
  detectUpgrades,
  parseSpec,
} from "./lib/packages";
import { printCodemod, runCodemod } from "./lib/codemod";
import { listAllUpgrades, planFleet, printFleet } from "./lib/fleet";
import { findNotes, printNotes, saveNote } from "./lib/notes";
import type { UpgradePlan } from "./lib/plan";
import type { MigrationTool } from "./lib/migration-tools";
import { auditDiff, printAudit } from "./lib/audit";
import { previewImpact, printImpact } from "./lib/impact";
import { findMigrationTools, printMigrationTools } from "./lib/migration-tools";
import { buildReport } from "./lib/report";
import { diffApi, printApiDiff } from "./lib/typescript/apidiff";
import { findDefaultReliance, printDefaultReliance } from "./lib/typescript/defaults";
import { findTestGaps, printTestGaps } from "./lib/test-gaps";
import { printUpstream, upstreamExamples } from "./lib/upstream";
import { findDeprecations, printDeprecations } from "./lib/deprecations";
import { findDuplicates, printDoctor, printDuplicates, runDoctor } from "./lib/doctor";
import {
  clearCheckpoints,
  listCheckpoints,
  printCheckpoint,
  printCheckpoints,
  printClear,
  printRestore,
  restoreCheckpoint,
  saveCheckpoint,
} from "./lib/checkpoint";
import { printVerify, recordBaseline, verify } from "./lib/verify";
import {
  findWorkspaceRoot,
  listWorkspaces,
  workspacesUsing,
} from "./lib/workspaces";
import { planUpgrades } from "./lib/plan";

const USAGE = `Usage: safebump <command> [args] [options]

Commands:
  doctor [pkg[@version]...] Preflight: install matches manifests and lockfile, type checker resolves, tsconfig,
                            git state, Node vs engines (incl. the targets'), duplicate copies; exit 1 on failure
  list                      Major-version upgrades available (all workspaces when run at a workspace root)
  detect [git-ref]          Packages bumped in package.json relative to git-ref (default: current branch)
  plan <pkg>[@version]...   Every package that must move with these upgrades: required peers, dependents
                            whose peer ranges break, lockstep siblings, @types. Prints the upgrade command
  upgrade <pkg>@<version>...  Set versions in package.json and run the project's package manager install
  checker                   Which type-check command will be used, and why
  tsc                       Raw type errors (exit code 1 if there are any)
  errors <pkg>...           Type errors mapped to code blocks, ordered and grouped into waves for fixing
  impact <pkg>[@version]... Blast radius before installing: files and import sites touched, removed and changed
                            APIs in use, behavior changes, risk level (runs plan)
  api-diff <pkg> [from] [to]
                            What changed between versions in the APIs this project uses: removed/added members,
                            signature changes, changed @default values and deprecations. from defaults to the
                            installed version, to to latest
  deprecations <pkg>...     Uses of APIs the installed versions mark @deprecated (usually what the next major
                            removes), grouped by API with the replacement the deprecation names
  duplicates <pkg>...       Packages (and their scope family) installed in more than one version
  defaults <pkg> [from] [to]
                            Options whose default changed between versions, and the call sites that omit them
                            (so they silently get the new default), with the old value to pin
  test-gaps <pkg>...        Files using the packages that no test reaches (or only with the package mocked):
                            where to write characterization tests before upgrading
  upstream <pkg> [from] [to]
                            How the package's maintainers changed their own examples, docs and tests between the
                            versions, ranked by the names this project imports (--max-files, --max-lines)
  checkpoint save <label>   Snapshot the working tree (incl. untracked files) without touching HEAD or the index;
                            counts type errors and audit findings unless --errors N or --fast
  checkpoint list           Checkpoints with error and audit counts; exit 1 when the last rounds regressed or
                            stalled, or the latest hides errors (audit findings never count as best)
  checkpoint restore <id|best|last>
                            Make the working tree match a checkpoint (the current state is saved first)
  checkpoint clear          Delete all checkpoints
  api <pkg> [symbol...]     New-version signatures of <pkg> symbols the project imports; flags removed exports
  refs <file> <line>        Code blocks that reference the declaration containing file:line (any line in it)
  verify baseline           Record current type/test/lint/build failures before upgrading
  verify                    Run those checks again and report only failures that are new since the baseline
                            (exit code 1 if any). --timeout <s> per script (default 600)
  audit [ref]               Added casts, suppressions, weakened tests or tsconfig since ref (default HEAD);
                            exit code 1 if any
  codemod <transform.ts>    Apply one mechanical change across the project (see assets/codemod-template.ts).
                            --dry-run shows diffs; --files <regex> limits files
  fleet                     All pending upgrades split into sequenced groups (one branch each), safest first.
                            --fast skips the impact preview used for risk ordering
  workspaces [pkg...]       Workspace packages in this monorepo, or only those depending on pkg
  notes <pkg> [from] [to]   Cached migration notes (bundled with the skill or saved in .safebump/)
  notes save <pkg> <from> <to> <file>
                            Save research output as notes for later sessions
  report [base-ref]         PR description skeleton: version table, change stats, sections for you to fill

Options:
  --root <dir>        Project root containing package.json and tsconfig.json (default: cwd)
  --checker <cmd>     Type-check command to run instead of the detected one (or set SAFEBUMP_TYPECHECK).
                      Must print tsc-style diagnostics
  --json              Machine-readable output
  --max-errors N      errors: max error messages shown per block (default 5)
  --all-workspaces    plan/upgrade: include every workspace package that depends on the targets
`;

const MAX_BLOCKS_LISTED = 60;

const printErrors = (pkg: string, a: ErrorAnalysis, maxErrors: number) => {
  if (a.totalErrors === 0) {
    console.log("No type errors. The build is clean.");
    return;
  }

  const files = new Set(a.blocks.map((b) => b.relPath));
  console.log(
    `${a.totalErrors} type errors. ` +
      (a.phase === "package"
        ? `Current phase: ${a.blocks.length} blocks in ${files.size} files that use ${pkg}.` +
          (a.deferredBlocks > 0
            ? ` ${a.deferredBlocks} other blocks deferred; many are knock-on errors, re-run after this phase.`
            : "")
        : `No remaining errors touch ${pkg}; ${a.blocks.length} blocks in ${files.size} files.`),
  );

  if (a.repeated.length > 0) {
    console.log(
      `\n## Repeated errors: consider one codemod each (assets/codemod-template.ts) instead of hand edits`,
    );
    for (const r of a.repeated) {
      console.log(
        `- ${r.count}× in ${r.files.length} file(s): ${r.message.replace(/\n\s*/g, " ").slice(0, 160)}`,
      );
    }
  }

  const blocksByFile = new Map<string, typeof a.blocks>();
  for (const b of a.blocks) {
    blocksByFile.set(b.relPath, [...(blocksByFile.get(b.relPath) ?? []), b]);
  }

  let listed = 0;
  a.waves.forEach((wave, i) => {
    console.log(
      `\n## Wave ${i + 1}${i === 0 ? " (no upstream errors)" : ` (after wave ${i})`}: ${wave.files.length} file(s)`,
    );
    for (const file of wave.files) {
      console.log(`\n### ${file}`);
      for (const b of blocksByFile.get(file) ?? []) {
        if (listed++ >= MAX_BLOCKS_LISTED) continue;
        const uses =
          b.usesPackage.length > 0 ? ` uses ${b.usesPackage.join(", ")}` : "";
        const deps =
          b.dependsOn.length > 0 ? ` after ${b.dependsOn.join(", ")}` : "";
        console.log(`- [${b.id}] ${b.kind} ${b.name}${uses}${deps}`);
        for (const e of b.errors.slice(0, maxErrors)) {
          console.log(
            `    ${e.line}:${e.column} ${e.message.replace(/\n\s*/g, " ")}`,
          );
        }
        if (b.errors.length > maxErrors) {
          console.log(`    (+${b.errors.length - maxErrors} more)`);
        }
      }
    }
  });
  if (listed > MAX_BLOCKS_LISTED) {
    console.log(
      `\n(${listed - MAX_BLOCKS_LISTED} more blocks not shown; use --json for all)`,
    );
  }

  if (a.unmapped.length > 0) {
    console.log(`\n## Errors outside any code block`);
    for (const e of a.unmapped.slice(0, 20)) {
      console.log(`- ${e.path}:${e.line}:${e.column} ${e.message}`);
    }
  }
};

const printPlan = (plan: UpgradePlan, tools: MigrationTool[] = []) => {
  console.log(`## Upgrade set (${plan.upgrades.length} package(s))`);
  for (const u of plan.upgrades) {
    console.log(`- ${u.name} ${u.from ?? "(not installed)"} → ${u.to}`);
    for (const reason of u.reasons) console.log(`    ${reason}`);
  }
  if (plan.conflicts.length > 0) {
    console.log(`\n## Conflicts (resolve before upgrading)`);
    for (const c of plan.conflicts) console.log(`- ${c}`);
  }
  if (plan.notes.length > 0) {
    console.log(`\n## Notes`);
    for (const n of plan.notes) console.log(`- ${n}`);
  }
  if (plan.upgrades.length > 0 && plan.conflicts.length === 0) {
    // packages an official tool versions itself are left to the tool
    const byTool = new Set(
      tools.filter((t) => t.replacesUpgrade).flatMap((t) => t.packages),
    );
    const rest = plan.upgrades.filter((u) => !byTool.has(u.name));
    console.log(`\nApply with:`);
    for (const t of tools.filter((t) => t.replacesUpgrade)) {
      console.log(`  ${t.id}: follow "Official migration tools" below (${t.packages.length} package(s))`);
    }
    if (rest.length > 0) {
      console.log(`  safebump upgrade ${rest.map((u) => `${u.name}@${u.to}`).join(" ")}`);
    }
  }
};

const printApi = (r: ApiReport) => {
  console.log(`# ${r.package}@${r.version ?? "(not installed)"}`);
  if (r.repository) console.log(`repository: ${r.repository}`);
  if (r.homepage) console.log(`homepage: ${r.homepage}`);
  console.log(
    r.docs.length > 0
      ? `docs in package:\n${r.docs.map((d) => `  ${d}`).join("\n")}`
      : "docs in package: none (check the repository's releases page)",
  );

  if (r.unresolvedModules.length > 0) {
    console.log(
      `\n## Import paths that no longer resolve\n${r.unresolvedModules.map((m) => `- ${m}`).join("\n")}`,
    );
  }

  const missing = r.symbols.filter((s) => s.missing);
  console.log(`\n## Imported names no longer exported`);
  if (missing.length === 0) console.log("none");
  for (const s of missing) {
    console.log(`- ${s.name} from "${s.module}" (${s.importedAt.join(", ")})`);
  }

  console.log(`\n## Signatures of imported names`);
  for (const s of r.symbols.filter((s) => !s.missing)) {
    console.log(
      `\n### ${s.name} from "${s.module}" (${s.importedAt.length} import site(s))`,
    );
    console.log(s.signature.trim() || "(signature unavailable)");
  }

  const typeEntries = Object.entries(r.types);
  if (typeEntries.length > 0) {
    console.log(`\n## Referenced types`);
    for (const [, text] of typeEntries) console.log(`\n${text}`);
  }

  for (const [module, exports] of Object.entries(r.moduleExports)) {
    if (missing.some((s) => s.module === module)) {
      console.log(
        `\n## All exports of "${module}" (look for renames)\n${exports.join(", ")}`,
      );
    }
  }
};

// "<pkg>" or "<pkg>@<version|range|tag>", scoped names included
const parseTargets = (args: string[]) =>
  args.map((arg) => {
    const at = arg.lastIndexOf("@");
    return at > 0
      ? { name: arg.slice(0, at), spec: arg.slice(at + 1) }
      : { name: arg };
  });

const main = async () => {
  ensureHeap();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      "max-errors": { type: "string", default: "5" },
      checker: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      files: { type: "string" },
      "all-workspaces": { type: "boolean", default: false },
      timeout: { type: "string" },
      fast: { type: "boolean", default: false },
      errors: { type: "string" },
      "max-files": { type: "string" },
      "max-lines": { type: "string" },
      "from-ref": { type: "string" },
      "to-ref": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  const root = path.resolve(values.root ?? process.cwd());
  const out = (data: unknown, text: () => void) =>
    values.json ? console.log(JSON.stringify(data, null, 2)) : text();

  const need = (n: number) => {
    if (args.length < n) {
      console.error(USAGE);
      process.exit(2);
    }
  };

  switch (command) {
    case "list": {
      const { upgrades } = await listAllUpgrades(root);
      const majors = upgrades.filter((u) => u.major && !u.name.startsWith("@types/"));
      return out(majors, () =>
        console.log(
          majors.length === 0
            ? "No major upgrades available."
            : majors
                .map(
                  (u) =>
                    `${u.name} ${u.from ?? "?"} → ${u.to}${u.workspaces.length === 1 && u.workspaces[0] === "." ? "" : `  (${u.workspaces.join(", ")})`}`,
                )
                .join("\n"),
        ),
      );
    }
    case "detect": {
      const upgrades = await detectUpgrades(root, args[0]);
      return out(upgrades, () =>
        console.log(
          upgrades.length === 0
            ? "No bumped packages detected."
            : upgrades.map((u) => `${u.packageName} ${u.newVersion}`).join("\n"),
        ),
      );
    }
    case "impact": {
      need(1);
      const r = await previewImpact(root, parseTargets(args));
      const { plan: _plan, ...report } = r;
      return out(report, () => printImpact(r));
    }
    case "doctor": {
      const r = await runDoctor(root, { packages: args, checker: values.checker });
      if (!r.ok) process.exitCode = 1;
      return out(r, () => printDoctor(r));
    }
    case "deprecations": {
      need(1);
      const r = findDeprecations(root, args);
      return out(r, () => printDeprecations(r));
    }
    case "duplicates": {
      need(1);
      const r = findDuplicates(root, args);
      if (r.duplicates.length > 0) process.exitCode = 1;
      return out(r, () => printDuplicates(r));
    }
    case "upstream": {
      need(1);
      const r = await upstreamExamples(root, args[0]!, args[1], args[2], {
        maxFiles: values["max-files"] ? Number(values["max-files"]) : undefined,
        maxLines: values["max-lines"] ? Number(values["max-lines"]) : undefined,
        fromRef: values["from-ref"],
        toRef: values["to-ref"],
      });
      if (r.error) process.exitCode = 1;
      return out(r, () => printUpstream(r));
    }
    case "checkpoint": {
      const sub = args[0];
      if (sub === "save") {
        need(2);
        const counting = values.errors === undefined && !values.fast;
        const cp = await saveCheckpoint(root, args.slice(1).join(" "), {
          errors: values.errors !== undefined ? Number(values.errors) : undefined,
          audit: counting ? (await auditDiff(root, "HEAD")).findings.length : undefined,
          checker:
            values.errors === undefined && !values.fast
              ? resolveChecker(root, values.checker)
              : undefined,
        });
        return out(cp, () => printCheckpoint(cp));
      }
      if (sub === "list") {
        const list = await listCheckpoints(root);
        if (list.stalled || list.regressed || list.cheated) process.exitCode = 1;
        return out(list, () => printCheckpoints(list));
      }
      if (sub === "restore") {
        need(2);
        const target = /^\d+$/.test(args[1]!) ? Number(args[1]) : args[1]!;
        const r = await restoreCheckpoint(root, target);
        return out(r, () => printRestore(r));
      }
      if (sub === "clear") {
        const r = await clearCheckpoints(root);
        return out(r, () => printClear(r));
      }
      console.error(USAGE);
      process.exit(2);
    }
    case "defaults": {
      need(1);
      const r = await findDefaultReliance(root, args[0]!, args[1], args[2]);
      return out(r, () => printDefaultReliance(r));
    }
    case "test-gaps": {
      need(1);
      const r = findTestGaps(root, args);
      return out(r, () => printTestGaps(r));
    }
    case "api-diff": {
      need(1);
      const d = await diffApi(root, args[0]!, args[1], args[2]);
      return out(d, () => printApiDiff(d));
    }
    case "plan": {
      need(1);
      const targets = parseTargets(args);
      const extraDirs = values["all-workspaces"]
        ? workspacesUsing(root, targets.map((t) => t.name)).map((w) => w.dir)
        : [];
      const plan = await planUpgrades(root, targets, extraDirs);
      const migrationTools = await findMigrationTools(root, plan.upgrades);
      return out({ ...plan, migrationTools }, () => {
        printPlan(plan, migrationTools);
        printMigrationTools(migrationTools);
      });
    }
    case "upgrade": {
      need(1);
      // also accept the older "upgrade <pkg> <version>" form
      const specs =
        args.length === 2 && !args[1]!.includes("@") && !/@./.test(args[0]!.slice(1))
          ? [{ packageName: args[0]!, newVersion: args[1]! }]
          : args.map(parseSpec);
      const workspaceRoot = findWorkspaceRoot(root);
      const result = await applyUpgrades(root, specs, {
        extraDirs: values["all-workspaces"]
          ? workspacesUsing(root, specs.map((u) => u.packageName)).map((w) => w.dir)
          : [],
        installRoot: workspaceRoot ?? root,
      });
      return out(result, () => {
        for (const u of result.applied) {
          const where = path.relative(root, u.manifest) === "package.json" ? "" : ` (${path.relative(root, u.manifest)})`;
          console.log(`${u.packageName}: ${u.from} → ${u.written}${where}`);
        }
        console.log(`Ran ${result.packageManager} install.`);
        if (result.peerWarnings.length > 0) {
          console.log(
            `\nThe install reported peer dependency problems:\n${result.peerWarnings.join("\n")}`,
          );
        }
      });
    }
    case "checker": {
      const checker = resolveChecker(root, values.checker);
      return out(checker, () =>
        console.log(`${checker.command}\n  (${checker.source})`),
      );
    }
    case "errors": {
      need(1);
      const checker = resolveChecker(root, values.checker);
      const analysis = await analyzeErrors(root, args, checker);
      return out({ checker, ...analysis }, () => {
        console.log(`checker: ${checker.command} (${checker.source})`);
        printErrors(args.join(", "), analysis, Number(values["max-errors"]));
      });
    }
    case "api": {
      need(1);
      const report = describeApi(
        root,
        args[0]!,
        args.length > 1 ? args.slice(1) : undefined,
      );
      return out(report, () => printApi(report));
    }
    case "refs": {
      need(2);
      const result = findReferences(root, args[0]!, Number(args[1]));
      return out(result, () => {
        console.log(
          `${result.block.kind} ${result.block.name} [${result.block.id}] is referenced by ${result.references.length} block(s)`,
        );
        for (const r of result.references) {
          console.log(`\n### [${r.id}] ${r.kind} ${r.name}\n${r.text}`);
        }
      });
    }
    case "verify": {
      const checker = resolveChecker(root, values.checker);
      const opts = {
        timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
      };
      if (args[0] === "baseline") {
        const b = await recordBaseline(root, checker, opts);
        return out(b, () =>
          console.log(
            `Baseline recorded at ${b.recordedAt}: ` +
              b.checks
                .map(
                  (c) =>
                    `${c.name} ${c.status}${c.failures?.length ? ` (${c.failures.length})` : ""}`,
                )
                .join(", "),
          ),
        );
      }
      const r = await verify(root, checker, opts);
      if (!r.ok) process.exitCode = 1;
      return out(r, () => printVerify(r));
    }
    case "audit": {
      const r = await auditDiff(root, args[0]);
      if (!r.ok) process.exitCode = 1;
      return out(r, () => printAudit(r));
    }
    case "codemod": {
      need(1);
      const result = await runCodemod(root, args[0]!, {
        dryRun: values["dry-run"],
        filter: values.files,
      });
      return out(result, () => printCodemod(result));
    }
    case "fleet": {
      const fleet = await planFleet(root);
      for (const g of fleet.groups.filter((g) => g.kind === "major")) {
        g.tools = await findMigrationTools(root, g.upgrades);
      }
      if (!values.fast) {
        for (const g of fleet.groups.filter((g) => g.kind === "major")) {
          try {
            const r = await previewImpact(
              root,
              g.upgrades.map((u) => ({ name: u.name, spec: u.to })),
            );
            // impact re-plans without knowing earlier groups land first, so
            // only count this group's own packages
            const own = r.packages.filter((p) =>
              g.upgrades.some((u) => u.name === p.name),
            );
            const order = ["low", "medium", "high"] as const;
            const level = own.reduce<(typeof order)[number]>(
              (worst, p) => (order.indexOf(p.risk) > order.indexOf(worst) ? p.risk : worst),
              "low",
            );
            g.risk = {
              level,
              reasons: own.filter((p) => p.risk !== "low").map((p) => `${p.name} (${p.risk}): ${p.reasons.join("; ")}`),
            };
          } catch (e) {
            g.risk = {
              level: "medium",
              reasons: [`impact preview failed: ${e instanceof Error ? e.message : String(e)}`],
            };
          }
        }
      }
      return out(fleet, () => printFleet(fleet));
    }
    case "workspaces": {
      const list = args.length > 0 ? workspacesUsing(root, args) : listWorkspaces(root);
      return out(list, () => {
        const wsRoot = findWorkspaceRoot(root);
        if (!wsRoot) console.log("Not a workspace (monorepo); only the project itself.");
        for (const w of list) {
          console.log(
            `- ${w.relPath} ${w.name ?? ""}${w.hasTsconfig ? "" : " (no tsconfig.json)"}${args.length > 0 ? `: ${args.filter((a) => a in w.dependencies).map((a) => `${a}@${w.dependencies[a]}`).join(", ")}` : ""}`,
          );
        }
      });
    }
    case "notes": {
      if (args[0] === "save") {
        need(5);
        const saved = saveNote(root, args[1]!, args[2]!, args[3]!, args[4]!);
        return out({ saved }, () => console.log(`Saved to ${saved}`));
      }
      need(1);
      const notes = findNotes(root, args[0]!, args[1], args[2]);
      return out(notes, () => printNotes(notes, args[0]!));
    }
    case "report": {
      // includes the audit, since reviewers should see it either way
      const baseRef = args[0] ?? "HEAD";
      const audit = await auditDiff(root, baseRef);
      const auditSection = audit.ok
        ? "## Audit\n\nNo added casts, suppressions, or weakened tests."
        : `## Audit\n\n${audit.findings.map((f) => `- \`${f.file}:${f.line}\` ${f.rule}: \`${f.text.trim()}\``).join("\n")}`;
      const report = await buildReport({
        projectRoot: root,
        baseRef,
        sections: [auditSection],
      });
      return out({ markdown: report }, () => console.log(report));
    }
    case "tsc": {
      const checker = resolveChecker(root, values.checker);
      const errors = await getBuildErrors(root, checker);
      if (errors.length > 0) process.exitCode = 1;
      return out(errors, () =>
        console.log(
          errors.length === 0
            ? "No type errors."
            : errors
                .map((e) => `${e.path}:${e.line}:${e.column} ${e.message}`)
                .join("\n"),
        ),
      );
    }
    default:
      console.log(USAGE);
      process.exit(values.help || !command ? 0 : 2);
  }
};

// agents often pipe output through `head`; a closed pipe isn't an error
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

main().catch((e: unknown) => {
  console.error(`safebump: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
