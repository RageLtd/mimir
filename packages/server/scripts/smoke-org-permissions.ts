/**
 * MIM-69 live PERMISSIONS smoke — proves the DATABASE ITSELF refuses
 * cross-org access on scoped (JWT) sessions, independent of the app-layer
 * WHERE org_id filters.
 *
 * Run against a THROWAWAY SurrealDB instance, never a live brain — it
 * creates and mutates rows:
 *
 *   docker run -d --name mimir-smoke-surreal -p 8123:8000 \
 *     surrealdb/surrealdb:v3.0.4 start --user root --pass root memory
 *
 * (v3.0.4 matches the homelab/cloud version; the v2 images predate the
 * FULLTEXT index syntax and fail initSchema.)
 *
 *   SURREAL_URL=http://127.0.0.1:8123/rpc SURREAL_USER=root SURREAL_PASS=root \
 *   SURREAL_NS=smoke SURREAL_DB=smoke SURREAL_ACCESS_SECRET=smoke-bridge-secret \
 *   MIMIR_LOG_FILE=/tmp/mimir-smoke-permissions.log \
 *   bun packages/server/scripts/smoke-org-permissions.ts
 *
 * Shell-set env vars beat .env in Bun, so the repo .env's SURREAL_URL never
 * engages. Exits non-zero on any failed check.
 */

import { mintSurrealToken } from "../src/auth/surreal-bridge";
import { config } from "../src/config";
import { closeDb, connectScoped, getDb, initSchema } from "../src/db/surreal";
import { attempt } from "../src/util/result";

const ORG_A = "smoke_org_a";
const ORG_B = "smoke_org_b";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  const suffix = ok ? "" : ` — ${JSON.stringify(detail)}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`);
  if (!ok) failures++;
}

interface SmokeRow {
  id: unknown;
  content?: string;
  org_id?: string;
}

const vec = new Array(config.embedding.dimensions).fill(0);

// ---- Boot: schema + access method + PERMISSIONS (secret is set via env) ----
if (!config.auth.surrealAccessSecret) {
  console.error("SURREAL_ACCESS_SECRET must be set for this smoke");
  process.exit(1);
}
await initSchema();
const root = await getDb();

// ---- Seed both orgs via the PERMISSIONS-bypassing root connection ----
async function seedMemory(orgId: string, content: string) {
  const [rows] = await root.query<[SmokeRow[]]>(
    "CREATE memory SET content = $content, embedding = $vec, org_id = $orgId",
    { content, vec, orgId },
  );
  const row = rows?.[0];
  if (!row) throw new Error(`seed failed for ${orgId}`);
  return row;
}
const memA = await seedMemory(ORG_A, "org A secret");
const memB = await seedMemory(ORG_B, "org B secret");
await root.query(
  "CREATE message_log SET role = 'user', content = 'org A message', org_id = $orgId",
  { orgId: ORG_A },
);
await root.query(
  "CREATE message_log SET role = 'user', content = 'org B message', org_id = $orgId",
  { orgId: ORG_B },
);
await root.query(
  "CREATE project SET title = 'org A project', org_id = $orgId",
  {
    orgId: ORG_A,
  },
);
await root.query(
  "CREATE project SET title = 'org B project', org_id = $orgId",
  {
    orgId: ORG_B,
  },
);

// ---- Scoped session for org A ----
const tokenA = mintSurrealToken({ userId: "user_a", orgId: ORG_A });
const scopedA = await connectScoped(tokenA);

const [aMemories] = await scopedA.query<[SmokeRow[]]>("SELECT * FROM memory");
check(
  "org A sees only its own memory rows",
  aMemories.length === 1 && aMemories.every((r) => r.org_id === ORG_A),
  aMemories.map((r) => r.org_id),
);

const [bDirect] = await scopedA.query<[SmokeRow[]]>("SELECT * FROM $rid", {
  rid: memB.id,
});
check("org A cannot read org B's record by id", bDirect.length === 0, bDirect);

const [aLogs] = await scopedA.query<[SmokeRow[]]>("SELECT * FROM message_log");
check(
  "org A sees only its own message_log rows",
  aLogs.length === 1 && aLogs.every((r) => r.org_id === ORG_A),
  aLogs.map((r) => r.org_id),
);

const [aProjects] = await scopedA.query<[SmokeRow[]]>("SELECT * FROM project");
check(
  "org A sees only its own project rows",
  aProjects.length === 1 && aProjects.every((r) => r.org_id === ORG_A),
  aProjects.map((r) => r.org_id),
);

// Cross-org CREATE: the create-permission predicate evaluates against the
// new row's org_id, so stamping org B from A's session must be refused —
// either an error or a silently-denied empty result, but never a row.
const [createErr, createRows] = await attempt(async () => {
  const [rows] = await scopedA.query<[SmokeRow[]]>(
    "CREATE memory SET content = 'intrusion', embedding = $vec, org_id = $orgId",
    { vec, orgId: ORG_B },
  );
  return rows;
});
check(
  "org A cannot create a row stamped org B",
  createErr !== null || (createRows ?? []).length === 0,
  createErr?.message ?? createRows,
);
const [bMemCountAfterCreate] = await root.query<[{ count: number }[]]>(
  "SELECT count() AS count FROM memory WHERE org_id = $orgId GROUP ALL",
  { orgId: ORG_B },
);
check(
  "no intrusion row landed in org B (root check)",
  bMemCountAfterCreate[0]?.count === 1,
  bMemCountAfterCreate,
);

// Cross-org UPDATE / DELETE: the select permission hides B's row, so these
// must touch zero rows regardless of error shape.
const [updateErr] = await attempt(() =>
  scopedA.query("UPDATE $rid SET content = 'defaced'", { rid: memB.id }),
);
const [deleteErr] = await attempt(() =>
  scopedA.query("DELETE $rid", { rid: memB.id }),
);
const [bAfterMutation] = await root.query<[SmokeRow[]]>("SELECT * FROM $rid", {
  rid: memB.id,
});
check(
  "org B's row survives org A's update/delete attempts intact",
  bAfterMutation.length === 1 && bAfterMutation[0]?.content === "org B secret",
  {
    updateErr: updateErr?.message,
    deleteErr: deleteErr?.message,
    row: bAfterMutation,
  },
);

// Own-org CREATE still works on the scoped session.
const [ownRows] = await scopedA.query<[SmokeRow[]]>(
  "CREATE memory SET content = 'org A note', embedding = $vec, org_id = $orgId",
  { vec, orgId: ORG_A },
);
check("org A can create its own rows", ownRows.length === 1, ownRows);

await scopedA.close();

// ---- Scoped session for org B (inverted view) ----
const tokenB = mintSurrealToken({ userId: "user_b", orgId: ORG_B });
const scopedB = await connectScoped(tokenB);
const [bMemories] = await scopedB.query<[SmokeRow[]]>("SELECT * FROM memory");
check(
  "org B sees only its own memory rows",
  bMemories.length === 1 && bMemories.every((r) => r.org_id === ORG_B),
  bMemories.map((r) => r.org_id),
);
const [aDirect] = await scopedB.query<[SmokeRow[]]>("SELECT * FROM $rid", {
  rid: memA.id,
});
check("org B cannot read org A's record by id", aDirect.length === 0, aDirect);
await scopedB.close();

// ---- Tampered token is rejected at authenticate ----
const [tamperErr] = await attempt(() => connectScoped(`${tokenA}x`));
check(
  "tampered token is rejected",
  tamperErr !== null,
  "authenticate accepted a bad signature",
);

await closeDb();
console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
