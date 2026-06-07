/**
 * Cluster grouping for the consolidation pass — pure union-find over a list of
 * near-neighbour edges. Memories joined (directly or transitively) by edges at
 * or below mergeDistance form a cluster; clusters of two or more are candidates
 * for merging into a single canonical memory.
 *
 * Components are capped at maxClusterSize so one densely-connected hub can't
 * pull dozens of memories into a single merge.
 */

export interface NeighborEdge {
  readonly a: string;
  readonly b: string;
  readonly distance: number;
}

export interface ClusterOpts {
  readonly mergeDistance: number;
  readonly maxClusterSize: number;
}

/** Group memory ids into clusters. Returns clusters of size >= 2, each sorted
 *  for determinism and truncated to maxClusterSize. */
export function groupClusters(
  edges: readonly NeighborEdge[],
  opts: ClusterOpts,
): string[][] {
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    // Path compression.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };

  const union = (x: string, y: string) => {
    add(x);
    add(y);
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const edge of edges) {
    if (edge.distance > opts.mergeDistance) continue;
    if (edge.a === edge.b) {
      add(edge.a);
      continue;
    }
    union(edge.a, edge.b);
  }

  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    const group = groups.get(root) ?? [];
    group.push(node);
    groups.set(root, group);
  }

  const clusters: string[][] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    clusters.push([...members].sort().slice(0, opts.maxClusterSize));
  }

  // Stable ordering across runs: sort clusters by their first member.
  return clusters.sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? ""));
}
