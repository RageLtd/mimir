/**
 * Project entity routes.
 *
 * Exposes the Project store to mimir-acp so each session can resolve its
 * own project UUID at startup. The UUID then replaces the filesystem path
 * as the cross-table identifier in message_log, memory, cart_file, etc.
 *
 *   POST /v1/projects/resolve  — get-or-create by git_remote / local_path
 *   GET  /v1/projects/:id      — fetch a single project
 *   PATCH /v1/projects/:id     — update title/description/technologies/purpose
 */

import { Hono } from "hono";
import { rootScope } from "../db/scope";
import { getDb } from "../db/surreal";
import { type IdentityEnv, scopeOrgId } from "../middleware/identity";
import { getProject, resolveProject, updateProject } from "../projects/store";
import { log } from "../util/logger";
import { attempt } from "../util/result";

export const projects = new Hono<IdentityEnv>();

type ResolveBody = {
  gitRemote?: unknown;
  localPath?: unknown;
  title?: unknown;
  description?: unknown;
  technologies?: unknown;
  purpose?: unknown;
};

const asString = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const asStringArray = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;

projects.post("/resolve", async (c) => {
  const [parseErr, body] = await attempt(
    () => c.req.json() as Promise<ResolveBody>,
  );
  if (parseErr) {
    return c.json({ error: `Invalid JSON: ${parseErr.message}` }, 400);
  }

  const gitRemote = asString(body.gitRemote);
  const localPath = asString(body.localPath);
  if (!gitRemote && !localPath) {
    return c.json(
      { error: "At least one of gitRemote or localPath is required" },
      400,
    );
  }

  const scope = rootScope(await getDb(), scopeOrgId(c));
  const [resolveErr, project] = await attempt(() =>
    resolveProject(scope, {
      gitRemote,
      localPath,
      title: asString(body.title),
      description: asString(body.description),
      technologies: asStringArray(body.technologies),
      purpose: asString(body.purpose),
    }),
  );
  if (resolveErr) {
    log.error({ error: resolveErr.message, body }, "project resolve failed");
    return c.json({ error: resolveErr.message }, 500);
  }
  if (!project) {
    return c.json({ error: "resolveProject returned no record" }, 500);
  }
  return c.json({ project });
});

projects.get("/:id", async (c) => {
  const id = c.req.param("id");
  const scope = rootScope(await getDb(), scopeOrgId(c));
  const [err, project] = await attempt(() => getProject(scope, id));
  if (err) {
    log.error({ error: err.message, id }, "project fetch failed");
    return c.json({ error: err.message }, 500);
  }
  if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json({ project });
});

projects.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const [parseErr, body] = await attempt(
    () => c.req.json() as Promise<ResolveBody>,
  );
  if (parseErr) {
    return c.json({ error: `Invalid JSON: ${parseErr.message}` }, 400);
  }

  const scope = rootScope(await getDb(), scopeOrgId(c));
  const [updateErr, project] = await attempt(() =>
    updateProject(scope, id, {
      title: asString(body.title),
      description:
        body.description === null ? null : asString(body.description),
      technologies: asStringArray(body.technologies),
      purpose: body.purpose === null ? null : asString(body.purpose),
    }),
  );
  if (updateErr) {
    log.error({ error: updateErr.message, id }, "project update failed");
    return c.json({ error: updateErr.message }, 500);
  }
  if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json({ project });
});
