import { readFileSync } from "fs";

// Posting results back to the pull/merge request from CI, so pipelines don't
// need their own shell for it. Reads only the environment each platform's
// CI provides; tokens come from secrets.

export type Forge = {
  kind: "github" | "gitlab";
  // the commit statuses go on (the PR head, or a new commit after a push)
  sha: string;
  upsertComment: (marker: string, body: string) => Promise<void>;
  setStatus: (context: string, state: "success" | "failure", description: string, sha?: string) => Promise<void>;
  addLabel: (label: string) => Promise<void>;
  pushUrl: () => string;
  branch: string;
};

const must = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const request = async (url: string, init: RequestInit & { token: string; auth: "bearer" | "gitlab" }) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.auth === "bearer"
      ? { authorization: `Bearer ${init.token}`, accept: "application/vnd.github+json" }
      : { "PRIVATE-TOKEN": init.token }),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? undefined : ((await res.json()) as unknown);
};

const github = (): Forge => {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? must("GITHUB_TOKEN");
  const repo = must("GITHUB_REPOSITORY");
  const api = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}`;
  const event = JSON.parse(readFileSync(must("GITHUB_EVENT_PATH"), "utf-8")) as {
    pull_request?: { number: number; head: { sha: string; ref: string } };
  };
  const pr = event.pull_request;
  if (!pr) throw new Error("not a pull_request event");
  const call = (path: string, init: RequestInit = {}) => request(`${api}${path}`, { ...init, token, auth: "bearer" });
  return {
    kind: "github",
    sha: pr.head.sha,
    branch: pr.head.ref,
    upsertComment: async (marker, body) => {
      const full = `${marker}\n${body}`;
      for (let page = 1; page <= 10; page++) {
        const comments = (await call(`/issues/${pr.number}/comments?per_page=100&page=${page}`)) as { id: number; body: string }[];
        const hit = comments.find((c) => c.body.startsWith(marker));
        if (hit) {
          await call(`/issues/comments/${hit.id}`, { method: "PATCH", body: JSON.stringify({ body: full }) });
          return;
        }
        if (comments.length < 100) break;
      }
      await call(`/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body: full }) });
    },
    setStatus: async (context, state, description, sha) => {
      await call(`/statuses/${sha ?? pr.head.sha}`, {
        method: "POST",
        body: JSON.stringify({ state, context, description: description.slice(0, 140) }),
      });
    },
    addLabel: async (label) => {
      await call(`/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) });
    },
    pushUrl: () => {
      const push = process.env.SAFEBUMP_PUSH_TOKEN || token;
      return `https://x-access-token:${push}@${new URL(process.env.GITHUB_SERVER_URL ?? "https://github.com").host}/${repo}.git`;
    },
  };
};

const gitlab = (): Forge => {
  const token = must("SAFEBUMP_GITLAB_TOKEN");
  const api = `${must("CI_API_V4_URL")}/projects/${must("CI_PROJECT_ID")}`;
  const iid = must("CI_MERGE_REQUEST_IID");
  const sha = must("CI_COMMIT_SHA");
  const call = (path: string, init: RequestInit = {}) => request(`${api}${path}`, { ...init, token, auth: "gitlab" });
  return {
    kind: "gitlab",
    sha,
    branch: must("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"),
    upsertComment: async (marker, body) => {
      const full = `${marker}\n${body}`;
      const notes = (await call(`/merge_requests/${iid}/notes?per_page=100`)) as { id: number; body: string }[];
      const hit = notes.find((n) => n.body.startsWith(marker));
      if (hit) await call(`/merge_requests/${iid}/notes/${hit.id}`, { method: "PUT", body: JSON.stringify({ body: full }) });
      else await call(`/merge_requests/${iid}/notes`, { method: "POST", body: JSON.stringify({ body: full }) });
    },
    setStatus: async (context, state, description, s) => {
      await call(`/statuses/${s ?? sha}`, {
        method: "POST",
        body: JSON.stringify({ name: context, state: state === "failure" ? "failed" : "success", description: description.slice(0, 255) }),
      });
    },
    addLabel: async (label) => {
      await call(`/merge_requests/${iid}`, { method: "PUT", body: JSON.stringify({ add_labels: label }) });
    },
    pushUrl: () => `https://oauth2:${token}@${must("CI_SERVER_HOST")}/${must("CI_PROJECT_PATH")}.git`,
  };
};

export const detectForge = (): Forge | undefined => {
  if (process.env.GITHUB_ACTIONS === "true") return github();
  if (process.env.GITLAB_CI === "true" && process.env.CI_MERGE_REQUEST_IID) return gitlab();
  return undefined;
};

export const MARKERS = { ci: "<!-- safebump -->", review: "<!-- safebump-review -->" } as const;
