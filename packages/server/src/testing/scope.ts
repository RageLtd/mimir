/**
 * Test-only OrgScope factory (MIM-69).
 *
 * Store functions take an OrgScope, but unit tests mock the store/db layer, so
 * the scope's connection is never dereferenced. An unconnected `new Surreal()`
 * is a valid Surreal object with no open socket — perfect as an inert stand-in,
 * and it needs no cast to satisfy the type.
 *
 * Prod code never imports this file.
 */

import { Surreal } from "surrealdb";
import { rootScope } from "../db/scope";

export function testScope(orgId = "test-org") {
  return rootScope(new Surreal(), orgId);
}
