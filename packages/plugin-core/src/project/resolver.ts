/** Local, deterministic project identity. No project metadata leaves the client. */

import { basename, resolve } from "node:path";

const stripRemoteSuffix = (value: string) =>
  value
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

export const normalizeGitRemote = (remote: string) => {
  const value = stripRemoteSuffix(remote);
  if (!value) return null;

  if (!value.includes("://")) {
    const scp = value.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (scp?.[1] && scp[2]) {
      return `${scp[1].toLowerCase()}/${stripRemoteSuffix(scp[2]).replace(/^\/+/, "")}`;
    }
  }

  try {
    const url = new URL(value);
    const path = stripRemoteSuffix(url.pathname).replace(/^\/+/, "");
    return path ? `${url.hostname.toLowerCase()}/${path}` : null;
  } catch {
    return value;
  }
};

const digestProjectKey = async (key: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mimir/project/v1\0${key}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `project:${hex.slice(0, 24)}`;
};

export type ResolvedProject = {
  readonly id: string;
  readonly title: string;
  readonly description: null;
  readonly git_remote: string | null;
  readonly local_path: string;
  readonly technologies: readonly string[];
  readonly purpose: null;
};

/**
 * The legacy server arguments remain in the signature so installed adapters
 * can upgrade independently. They are deliberately unused: identity derives
 * from the normalized git remote, with an absolute-path fallback for local
 * directories that have no remote yet.
 */
export const resolveProjectForPath = async (
  _serverUrl: string,
  _apiKey: string | undefined,
  projectPath: string,
  gitRemote: string | null,
) => {
  const localPath = resolve(projectPath);
  const normalizedRemote = gitRemote ? normalizeGitRemote(gitRemote) : null;
  const key = normalizedRemote
    ? `git:${normalizedRemote}`
    : `path:${localPath}`;
  const title = normalizedRemote
    ? normalizedRemote.split("/").slice(-2).join("/")
    : basename(localPath) || "untitled project";
  return {
    id: await digestProjectKey(key),
    title,
    description: null,
    git_remote: normalizedRemote,
    local_path: localPath,
    technologies: [],
    purpose: null,
  } satisfies ResolvedProject;
};
