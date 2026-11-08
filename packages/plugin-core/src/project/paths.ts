/**
 * Path normalisation for the project boundary.
 *
 * Cartographer's parser and the server's cart_file/cart_import rows want a
 * single canonical representation per path so dependents queries match. We
 * pick **relative-to-projectRoot** because that's what `git ls-files`
 * already emits and what cartographer's own resolver (run with cwd=root)
 * produces for import targets. Absolute paths inside the project get
 * collapsed; absolute paths outside become `../foo` form; already-relative
 * paths pass through untouched.
 *
 * Applied at three seams in Slice 1: session-start parse loop, reindex
 * worker, and the file-context lookup. After this helper is in place the
 * index stops carrying two representations of the same file.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export const toProjectRelative = (projectRoot: string, filePath: string) =>
  isAbsolute(filePath) ? relative(projectRoot, filePath) : filePath;

/**
 * Whether `filePath` (absolute, or relative to the root) lies inside
 * `projectRoot`. Compares path segments, not string prefixes, so
 * `/repo-other` is outside `/repo` and `/repo/..hidden` is inside it.
 */
export const isInsideProject = (projectRoot: string, filePath: string) => {
  const rel = relative(projectRoot, resolve(projectRoot, filePath));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
