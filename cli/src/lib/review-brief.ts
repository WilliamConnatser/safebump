import { readFileSync } from "fs";

import type { CoverageResult } from "./coverage";
import { measureCoverage } from "./coverage";
import { baseVersion, updateType } from "./ci";
import { findMigrationTools } from "./migration-tools";
import { findNotes } from "./notes";
import { detectUpgrades, installedVersion } from "./packages";
import { fetchReleaseNotes } from "./release-notes";
import type { ApiUse } from "./typescript/usage";
import { findApiUsage, matchesMemberChange } from "./typescript/usage";
import type { MemberChange, SymbolDiff } from "./typescript/apidiff";
import { diffApi, docDelta } from "./typescript/apidiff";
import { findDefaultReliance } from "./typescript/defaults";
import { diffImplementations } from "./impl-diff";

// The review agent's working document: for each upgraded package, the parts
// of its API this project actually uses, what changed in exactly those parts,
// whether tests run them, and the release notes for every version crossed.
// Scoping the review to the used surface is the point: a breaking change in
// an API the project never touches is noise.

type Target = { name: string; from: string; to: string };

const describeMember = (m: MemberChange) => {
  switch (m.kind) {
    case "removed":
      return `removed (was ${m.from ?? "?"})`;
    case "added":
      return `added${m.required ? " (required)" : ""}`;
    case "type":
      return `type ${m.from ?? "?"} → ${m.to ?? "?"}`;
    case "optionality":
      return `${m.from ?? "?"} → ${m.to ?? "?"}`;
    case "default":
      return `default ${m.from ?? "(undocumented)"} → ${m.to ?? "?"}`;
    case "deprecated":
      return `deprecated: ${m.to ?? ""}`;
    case "description":
      return `docs: ${m.from && m.to ? docDelta(m.from, m.to, 40) : (m.to ?? "")}`;
    default:
      return m.kind;
  }
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const changesFor = (use: ApiUse, symbols: SymbolDiff[]) => {
  const out: string[] = [];
  for (const s of symbols) {
    // a top-level export used directly; api-diff names a default import
    // "default", the usage map by its declared name (OpenAI)
    const isDefault = s.name === "default" && !use.owner && !symbols.some((x) => x.name === use.api);
    if (!use.owner && (s.name === use.api || isDefault)) {
      if (s.status === "removed") out.push("export removed");
      if (s.signatureChanged) out.push("signature changed");
      if (s.deprecated) out.push(`deprecated: ${clip(s.deprecated, 100)}`);
    }
    for (const m of s.members) {
      if (matchesMemberChange(use, m)) out.push(describeMember(m));
    }
  }
  return Array.from(new Set(out));
};

const executed = (use: ApiUse, coverage?: CoverageResult) => {
  if (!coverage?.available) return "?";
  return use.sites.some((site) => (coverage.executed[site.file] ?? []).includes(site.line)) ? "yes" : "no";
};

const packageSection = async (projectRoot: string, t: Target, coverage?: CoverageResult) => {
  const lines: string[] = [];
  const diff = await diffApi(projectRoot, t.name, t.from, t.to).catch(() => undefined);
  const usage = findApiUsage(projectRoot, t.name);
  const defaults = await findDefaultReliance(projectRoot, t.name, t.from, t.to).catch(() => undefined);
  const notes = await fetchReleaseNotes(projectRoot, t.name, t.from, t.to);
  const tools = await findMigrationTools(projectRoot, [{ name: t.name, from: t.from, to: t.to }]).catch(() => []);
  const cached = findNotes(projectRoot, t.name, t.from, t.to).filter((n) => n.relevant);

  lines.push(`# ${t.name} ${t.from} → ${t.to} (${updateType(t.from, t.to)})`, "");
  if (notes.repo) lines.push(`Repository: ${notes.repo}`, "");

  if (tools.length > 0 || cached.length > 0 || notes.migrationGuides.length > 0) {
    lines.push("## Migration guidance");
    for (const tool of tools) lines.push(`- Official tool (${tool.id}): ${tool.steps.join(" → ")}${tool.guide ? ` (guide: ${tool.guide})` : ""}`);
    for (const g of notes.migrationGuides) lines.push(`- Guide: [${g.title}](${g.url})`);
    // inlined: the reviewer's sandbox can't read outside the project
    for (const n of cached) {
      lines.push("", `### Cached migration notes (${n.source}, ${n.from} → ${n.to})`, "", readFileSync(n.path, "utf-8").trim(), "");
    }
    lines.push("");
  }

  const symbols = diff?.symbols ?? [];
  const runtime = usage.uses.filter((u) => !u.typeOnly && !u.testOnly);
  const other = usage.uses.filter((u) => u.typeOnly || u.testOnly);
  const changed = (u: ApiUse) => changesFor(u, symbols);

  lines.push(
    `## APIs this project uses (${runtime.length} at runtime, ${other.length} type-only or test-only)`,
    "",
    "Changed APIs first. \"Runs in tests\" is from runtime coverage (? = coverage unavailable).",
    "",
    "| API | How | Sites | What changed | Runs in tests |",
    "|---|---|---|---|---|",
  );
  const rows = [...runtime, ...other].sort((a, b) => changed(b).length - changed(a).length);
  for (const u of rows) {
    const c = changed(u);
    const sites = u.sites.slice(0, 3).map((s) => `${s.file}:${s.line}`).join(", ") + (u.sites.length > 3 ? ` +${u.sites.length - 3}` : "");
    lines.push(
      `| \`${u.api}\`${u.typeOnly ? " (types)" : u.testOnly ? " (tests)" : ""} | ${u.kinds.join(", ")} | ${sites} | ${c.length > 0 ? c.map((x) => clip(x, 140)).join("; ") : "unchanged"} | ${u.typeOnly ? "n/a" : executed(u, coverage)} |`,
    );
  }
  lines.push("");

  // the rest of the diff, so the agent knows it's out of scope
  const unusedChanges = symbols.reduce((n, s) => n + s.members.filter((m) => !rows.some((u) => matchesMemberChange(u, m))).length, 0);
  lines.push(`Changes to APIs this project does not use: ${unusedChanges} (out of scope for this review).`, "");

  // the dependency's own source, diffed for exactly the APIs used here:
  // catches behavior changes the types and the release notes don't mention
  const impl = await diffImplementations(
    projectRoot,
    t.name,
    t.from,
    t.to,
    runtime.filter((u) => u.kinds.some((k) => k !== "type")).slice(0, 25).map((u) => ({ api: u.api, owner: u.owner, member: u.member })),
  ).catch((e: unknown) => ({ diffs: [], notes: [`implementation diff failed: ${e instanceof Error ? e.message : String(e)}`], repo: undefined }));
  const changedImpl = impl.diffs.filter((d) => d.changed);
  lines.push(`## Implementation changes in the APIs this project uses (${changedImpl.length} of ${impl.diffs.length} diffed)`, "");
  for (const n of impl.notes) lines.push(`_note: ${n}_`);
  for (const d of changedImpl) {
    lines.push(`### \`${d.api}\`${d.file ? ` (${d.file})` : ""}${d.url ? ` · ${d.url}` : ""}`);
    for (const f of d.flags) lines.push(`- **${f.kind}**: ${f.detail}`);
    if (d.hunks) lines.push("", "```diff", d.hunks.split("\n").slice(0, 60).join("\n"), "```");
    lines.push("");
  }
  for (const d of impl.diffs.filter((d) => d.note && !d.changed)) lines.push(`- \`${d.api}\`: ${d.note}`);
  lines.push("");

  const relied = (defaults?.changes ?? []).filter((c) => c.sites.length > 0);
  if (relied.length > 0) {
    lines.push("## Changed defaults this project relies on");
    for (const c of relied) {
      lines.push(`- \`${c.owner}.${c.member}\`: ${c.oldDefault ?? "?"} → ${c.newDefault ?? "?"}. Evidence: "${clip(c.evidence, 200)}"`);
      for (const s of c.sites.slice(0, 5)) lines.push(`  - ${s.file}:${s.line} ${s.call} (${s.status})`);
    }
    lines.push("");
  }

  lines.push(
    `## Release notes (${notes.notes.length} of ${notes.versions.length} versions crossed have notes)`,
    "",
  );
  if (notes.missing.length > 0) lines.push(`No notes found for: ${notes.missing.slice(0, 30).join(", ")}${notes.missing.length > 30 ? ", …" : ""}`, "");
  for (const e of notes.errors) lines.push(`_note: ${e}_`);
  const ordered = [...notes.notes].sort((a, b) => Number(b.breaking) - Number(a.breaking));
  for (const n of ordered) {
    lines.push(`### ${n.version}${n.breaking ? " (breaking?)" : ""}${n.date ? ` · ${n.date.slice(0, 10)}` : ""}${n.url ? ` · ${n.url}` : ""}`, "", n.text.trim(), "");
  }
  if (notes.truncated) lines.push("_Release notes were truncated to fit; read the full notes at the links above._", "");
  return lines.join("\n");
};

export const buildReviewBrief = async (
  projectRoot: string,
  options: { base?: string; targets?: Target[]; coverage?: boolean; timeoutMs?: number },
) => {
  let targets = options.targets ?? [];
  if (options.base) {
    const bumped = await detectUpgrades(projectRoot, options.base);
    targets = (
      await Promise.all(
        bumped.map(async (u) => ({
          name: u.packageName,
          from: (await baseVersion(projectRoot, options.base!, u.packageName)) ?? "",
          to: installedVersion(projectRoot, u.packageName) ?? "",
        })),
      )
    ).filter((t) => t.from && t.to && t.from !== t.to);
  }
  if (targets.length === 0) return "# Review brief\n\nNo upgraded packages found.\n";

  const files = targets.flatMap((t) => findApiUsage(projectRoot, t.name).files);
  const coverage =
    options.coverage === false
      ? undefined
      : await measureCoverage(projectRoot, { sourceFiles: Array.from(new Set(files)), timeoutMs: options.timeoutMs });

  const sections: string[] = [];
  for (const t of targets) sections.push(await packageSection(projectRoot, t, coverage));
  return [
    "# Review brief",
    "",
    `Upgrades: ${targets.map((t) => `${t.name} ${t.from} → ${t.to}`).join(", ")}.`,
    coverage && !coverage.available ? `Runtime coverage unavailable: ${coverage.reason ?? "unknown"}.` : "",
    "",
    ...sections,
  ].join("\n");
};
