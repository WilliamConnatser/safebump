import semver from "semver";

import { run } from "./subprocess";

export type VersionMeta = {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  deprecated?: string;
};

export type Packument = {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionMeta>;
};

let registryUrl: Promise<string> | undefined;
const getRegistry = (cwd: string) =>
  (registryUrl ??= run("npm config get registry", { cwd }).then(
    ({ stdout }) => {
      const url = stdout.trim() || "https://registry.npmjs.org/";
      return url.endsWith("/") ? url : `${url}/`;
    },
  ));

const encodeName = (name: string) => name.replace("/", "%2f");

const headers = (accept: string) => {
  const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
  return {
    accept,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
};

const packuments = new Map<string, Promise<Packument>>();

// the abbreviated document has peerDependencies for every version, which is
// all the planner needs and much smaller than the full one
export const getPackument = (cwd: string, name: string) => {
  let cached = packuments.get(name);
  if (!cached) {
    cached = getRegistry(cwd).then(async (registry) => {
      const res = await fetch(`${registry}${encodeName(name)}`, {
        headers: headers("application/vnd.npm.install-v1+json"),
      });
      if (!res.ok) {
        throw new Error(
          `Registry lookup for ${name} failed (${res.status}). For a private registry, set NPM_TOKEN.`,
        );
      }
      return (await res.json()) as Packument;
    });
    packuments.set(name, cached);
  }
  return cached;
};

// the full manifest of one version, for fields the abbreviated document omits
export const getManifest = async (
  cwd: string,
  name: string,
  version: string,
) => {
  const registry = await getRegistry(cwd);
  const res = await fetch(`${registry}${encodeName(name)}/${version}`, {
    headers: headers("application/json"),
  });
  if (!res.ok) return undefined;
  return (await res.json()) as {
    types?: string;
    typings?: string;
    exports?: unknown;
    repository?: string | { url?: string };
  };
};

export const stableVersions = (p: Packument) =>
  Object.keys(p.versions).filter((v) => !semver.prerelease(v));

// resolves "latest", a dist-tag, an exact version or a range
export const resolveVersion = (p: Packument, spec?: string) => {
  if (!spec || spec === "latest") return p["dist-tags"].latest;
  if (p["dist-tags"][spec]) return p["dist-tags"][spec];
  if (p.versions[spec]) return spec;
  return semver.maxSatisfying(stableVersions(p), spec) ?? undefined;
};
