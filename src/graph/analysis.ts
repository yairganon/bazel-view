/**
 * Graph analysis algorithms for Bazel dependency analysis.
 * Designed to handle large graphs (2K+ nodes, 17K+ edges) without freezing.
 */

import type { ParsedGraph, GraphEdge } from './parser';

export interface NodeMetrics {
  id: string;
  inDegree: number;
  outDegree: number;
  depth: number;
  buildPhase: number;   // 0 = leaves (built first), higher = later
  isLeaf: boolean;
  isRoot: boolean;
  isBridge: boolean;
  uniqueParent: string | null;
  transitiveDepCount: number;
}

export interface BuildPhase {
  phase: number;
  nodes: string[];
  waitingBehind: number;    // how many targets in later phases
  blockingRatio: number;    // waitingBehind / nodes.length — higher = worse bottleneck
  isBottleneck: boolean;    // true if this phase is a real bottleneck
}


export interface PathDagNode {
  id: string;
  children: string[];   // next nodes in the path DAG
  pathCount: number;     // how many paths go through this node
  isBranch: boolean;     // has >1 child in the path DAG
  isMerge: boolean;      // has >1 parent in the path DAG
}

export interface PathGroup {
  viaNode: string;          // the node this group diverges through
  paths: string[][];        // all paths in this group
  representative: string[]; // shortest path as representative
}

export interface PathInfo {
  from: string;
  to: string;
  shortestPath: string[];
  essentialPaths: string[][];         // after suffix dedup — no redundant extensions
  allPathCount: number;               // total before dedup
  dominators: string[];               // nodes on ALL paths (cut any one = done)
  minCutNodes: string[];              // exact min set of nodes to cut
  minCutSize: number;
  pathGroups: PathGroup[];            // essential paths grouped by first divergence
  isUnique: boolean;
  reachable: boolean;
}

export interface AnalysisResult {
  nodeMetrics: Map<string, NodeMetrics>;
  bridges: GraphEdge[];
  articulationPoints: string[];
  longestPath: string[];
  heavyNodes: string[];
  packageStats: Map<string, { nodeCount: number; edgeCount: number }>;
  roots: string[];
  leaves: string[];
  buildPhases: BuildPhase[];
  totalDeps: number;   // BFS reachable from main root (excluding root itself)
}

type AdjList = Map<string, string[]>;

function buildAdjLists(graph: ParsedGraph): { forward: AdjList; reverse: AdjList } {
  const forward: AdjList = new Map();
  const reverse: AdjList = new Map();

  for (const node of graph.nodes) {
    forward.set(node.id, []);
    reverse.set(node.id, []);
  }

  for (const edge of graph.edges) {
    forward.get(edge.source)?.push(edge.target);
    reverse.get(edge.target)?.push(edge.source);
  }

  return { forward, reverse };
}

/**
 * Topological sort via Kahn's algorithm. Returns null if cycle detected.
 */
function topoSort(forward: AdjList, reverse: AdjList): string[] | null {
  const inDegree = new Map<string, number>();
  for (const [id, parents] of reverse) {
    inDegree.set(id, parents.length);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  let qh = 0;
  while (qh < queue.length) {
    const current = queue[qh++];
    order.push(current);
    for (const child of forward.get(current) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  return order.length === forward.size ? order : null;
}

/**
 * Compute depths via BFS from roots. Handles cycles gracefully.
 */
function computeDepths(forward: AdjList, reverse: AdjList): Map<string, number> {
  const depths = new Map<string, number>();
  for (const id of forward.keys()) depths.set(id, 0);

  // BFS from roots
  const roots: string[] = [];
  for (const [id, parents] of reverse) {
    if (parents.length === 0) roots.push(id);
  }

  const queue = roots.map(id => ({ id, depth: 0 }));
  let dh = 0;
  while (dh < queue.length) {
    const { id, depth } = queue[dh++];
    // Skip if we already found a longer path to this node
    if (depth < (depths.get(id) ?? 0)) continue;

    for (const child of forward.get(id) ?? []) {
      const newDepth = depth + 1;
      if (newDepth > (depths.get(child) ?? 0)) {
        depths.set(child, newDepth);
        queue.push({ id: child, depth: newDepth });
      }
    }
  }

  return depths;
}

/**
 * Compute transitive dep counts. Handles cycles via BFS from each node
 * with visited tracking. For large graphs, uses SCC condensation for speed.
 */
/**
 * Bitset operations for tracking reachable SCCs.
 * Each bitset is a Uint32Array where bit i = SCC i is reachable.
 */
function bitsetSize(n: number): number {
  return Math.ceil(n / 32);
}
function bitsetSet(bs: Uint32Array, i: number) {
  bs[i >>> 5] |= 1 << (i & 31);
}
function bitsetOr(dst: Uint32Array, src: Uint32Array) {
  for (let i = 0; i < dst.length; i++) dst[i] |= src[i];
}
function bitsetPopcount(bs: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < bs.length; i++) {
    let v = bs[i];
    // Hamming weight
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

function computeTransitiveDepCounts(forward: AdjList, sccs: string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  const numSCCs = sccs.length;
  const nodeToScc = new Map<string, number>();
  for (let i = 0; i < numSCCs; i++) {
    for (const node of sccs[i]) nodeToScc.set(node, i);
  }

  // Build condensed forward graph
  const sccForward = new Map<number, Set<number>>();
  for (let i = 0; i < numSCCs; i++) sccForward.set(i, new Set());
  for (const [source, targets] of forward) {
    const srcScc = nodeToScc.get(source)!;
    for (const t of targets) {
      const tgtScc = nodeToScc.get(t)!;
      if (srcScc !== tgtScc) sccForward.get(srcScc)!.add(tgtScc);
    }
  }

  // Topo sort SCC DAG
  const sccReverse = new Map<number, number[]>();
  for (let i = 0; i < numSCCs; i++) sccReverse.set(i, []);
  for (const [src, tgts] of sccForward) {
    for (const tgt of tgts) sccReverse.get(tgt)!.push(src);
  }
  const inDeg = new Map<number, number>();
  for (let i = 0; i < numSCCs; i++) inDeg.set(i, sccReverse.get(i)!.length);
  const queue: number[] = [];
  for (const [id, d] of inDeg) { if (d === 0) queue.push(id); }
  const sccOrder: number[] = [];
  let sh = 0;
  while (sh < queue.length) {
    const cur = queue[sh++];
    sccOrder.push(cur);
    for (const child of sccForward.get(cur) ?? []) {
      const nd = inDeg.get(child)! - 1;
      inDeg.set(child, nd);
      if (nd === 0) queue.push(child);
    }
  }

  // Compute exact reachable set per SCC using bitsets.
  // Process in reverse topo order (leaves first).
  // reachable[scc] = bitset of all transitively reachable SCCs (not including self).
  const bsLen = bitsetSize(numSCCs);
  const reachable = new Map<number, Uint32Array>();

  for (let i = sccOrder.length - 1; i >= 0; i--) {
    const sccId = sccOrder[i];
    const bs = new Uint32Array(bsLen);

    for (const dep of sccForward.get(sccId) ?? []) {
      bitsetSet(bs, dep); // direct dep
      const depBs = reachable.get(dep);
      if (depBs) bitsetOr(bs, depBs); // transitive deps of dep
    }

    reachable.set(sccId, bs);
  }

  // Convert bitset popcount to actual node count:
  // transitive deps = sum of SCC sizes for all reachable SCCs + (own SCC size - 1)
  const sccCounts = new Map<number, number>();
  for (let sccId = 0; sccId < numSCCs; sccId++) {
    const bs = reachable.get(sccId);
    if (!bs) { sccCounts.set(sccId, sccs[sccId].length - 1); continue; }

    let nodeCount = sccs[sccId].length - 1; // other nodes in own SCC
    // Count nodes in all reachable SCCs
    for (let word = 0; word < bsLen; word++) {
      let bits = bs[word];
      while (bits) {
        const bit = bits & (-bits); // lowest set bit
        const idx = word * 32 + (31 - Math.clz32(bit));
        if (idx < numSCCs) {
          nodeCount += sccs[idx].length;
        }
        bits ^= bit;
      }
    }
    sccCounts.set(sccId, nodeCount);
  }

  // Map back to original nodes
  for (const [nodeId, sccIdx] of nodeToScc) {
    counts.set(nodeId, sccCounts.get(sccIdx) ?? 0);
  }

  return counts;
}

/**
 * Tarjan's SCC algorithm. Returns list of strongly connected components.
 * Each SCC is a set of node IDs that form a cycle together.
 * O(V+E).
 */
function findSCCs(forward: AdjList): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of forward.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const v of forward.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }

  return sccs;
}

/**
 * Compute build phases bottom-up, handling cycles via SCC condensation.
 *
 * 1. Find SCCs (strongly connected components = cycles)
 * 2. Condense the graph: each SCC becomes a single super-node → guaranteed DAG
 * 3. Compute phases on the DAG
 * 4. Map phases back to original nodes (all nodes in an SCC share the same phase)
 *
 * Phase 0 = leaves (built first), Phase N = root (built last).
 */
function computeBuildPhases(forward: AdjList, reverse: AdjList, sccs: string[][]): { phases: Map<string, number>; grouped: BuildPhase[] } {
  const phases = new Map<string, number>();

  // Map each node to its SCC index
  const nodeToScc = new Map<string, number>();
  for (let i = 0; i < sccs.length; i++) {
    for (const node of sccs[i]) {
      nodeToScc.set(node, i);
    }
  }

  // Build condensed DAG (SCC-level graph)
  const sccForward: AdjList = new Map();
  const sccReverse: AdjList = new Map();
  for (let i = 0; i < sccs.length; i++) {
    sccForward.set(String(i), []);
    sccReverse.set(String(i), []);
  }

  const sccEdgeSet = new Set<string>();
  for (const [source, targets] of forward) {
    const srcScc = nodeToScc.get(source)!;
    for (const target of targets) {
      const tgtScc = nodeToScc.get(target)!;
      if (srcScc === tgtScc) continue; // skip intra-SCC edges
      const key = `${srcScc}|||${tgtScc}`;
      if (!sccEdgeSet.has(key)) {
        sccEdgeSet.add(key);
        sccForward.get(String(srcScc))!.push(String(tgtScc));
        sccReverse.get(String(tgtScc))!.push(String(srcScc));
      }
    }
  }

  // Topo sort the condensed DAG (guaranteed to succeed — no cycles)
  const order = topoSort(sccForward, sccReverse)!;

  // Compute phases on condensed DAG
  const sccPhases = new Map<string, number>();
  for (const id of order) sccPhases.set(id, 0);

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const deps = sccForward.get(id) ?? [];
    if (deps.length === 0) {
      sccPhases.set(id, 0);
    } else {
      let maxP = 0;
      for (const dep of deps) {
        maxP = Math.max(maxP, sccPhases.get(dep) ?? 0);
      }
      sccPhases.set(id, maxP + 1);
    }
  }

  // Map phases back to original nodes
  for (const [nodeId, sccIdx] of nodeToScc) {
    phases.set(nodeId, sccPhases.get(String(sccIdx)) ?? 0);
  }

  // Group by phase
  const groupMap = new Map<number, string[]>();
  for (const [id, phase] of phases) {
    const group = groupMap.get(phase) ?? [];
    group.push(id);
    groupMap.set(phase, group);
  }

  const sortedEntries = Array.from(groupMap.entries()).sort((a, b) => a[0] - b[0]);
  const totalNodes = phases.size;

  // Compute waiting behind: sum of all nodes in LATER phases (not including current)
  // Build from the end so we know exactly what's after each phase
  const phaseEntries = sortedEntries.map(([phase, nodes]) => ({
    phase, nodes, waitingBehind: 0, blockingRatio: 0, isBottleneck: false,
  }));
  let cumulative = 0;
  for (let i = phaseEntries.length - 1; i >= 0; i--) {
    phaseEntries[i].waitingBehind = cumulative;
    phaseEntries[i].blockingRatio = phaseEntries[i].nodes.length > 0
      ? cumulative / phaseEntries[i].nodes.length : 0;
    cumulative += phaseEntries[i].nodes.length;
  }
  const grouped: BuildPhase[] = phaseEntries;

  // Mark bottlenecks: phases where the blocking ratio is high
  // A phase is a bottleneck if:
  // 1. It has significantly fewer targets than the average phase
  // 2. AND there are many targets waiting behind it (not the last few phases)
  if (grouped.length > 2) {
    const avgSize = totalNodes / grouped.length;
    for (const p of grouped) {
      // Skip the last phase (root target, nothing waits after)
      if (p.waitingBehind === 0) continue;
      // Bottleneck: fewer targets than average AND high blocking ratio
      p.isBottleneck = p.nodes.length < avgSize * 0.5 && p.blockingRatio > 5;
    }
  }

  return { phases, grouped };
}

/**
 * Find bridge edges: edges where target has exactly 1 parent.
 * O(V+E) — just check in-degree.
 */
function findBridges(reverse: AdjList, edges: GraphEdge[]): GraphEdge[] {
  const bridges: GraphEdge[] = [];
  for (const edge of edges) {
    const parents = reverse.get(edge.target);
    if (parents && parents.length === 1) {
      bridges.push(edge);
    }
  }
  return bridges;
}

/**
 * Find articulation points: nodes where all children have single parent.
 */
function findArticulationPoints(forward: AdjList, reverse: AdjList): string[] {
  const points: string[] = [];
  for (const [nodeId, children] of forward) {
    if (children.length === 0) continue;
    const parents = reverse.get(nodeId);
    if (!parents || parents.length === 0) continue;

    if (children.every(child => {
      const childParents = reverse.get(child);
      return childParents !== undefined && childParents.length === 1;
    })) {
      points.push(nodeId);
    }
  }
  return points;
}

/**
 * Find longest path. Uses BFS/depth tracking with visited set to handle cycles.
 */
function findLongestPath(forward: AdjList, reverse: AdjList): string[] {
  const depths = computeDepths(forward, reverse);

  // Find the deepest node
  let maxDepth = 0;
  let deepest: string | null = null;
  for (const [id, d] of depths) {
    if (d > maxDepth) {
      maxDepth = d;
      deepest = id;
    }
  }
  if (!deepest) return [];

  // Trace back from deepest to a root
  const path: string[] = [deepest];
  const visited = new Set<string>([deepest]);
  let cur = deepest;

  while (true) {
    const parents = reverse.get(cur) ?? [];
    // Pick the parent with depth = cur depth - 1
    const curDepth = depths.get(cur) ?? 0;
    let bestParent: string | null = null;
    let bestDepth = -1;
    for (const p of parents) {
      const pd = depths.get(p) ?? 0;
      if (pd < curDepth && pd > bestDepth && !visited.has(p)) {
        bestDepth = pd;
        bestParent = p;
      }
    }
    if (!bestParent) break;
    path.unshift(bestParent);
    visited.add(bestParent);
    cur = bestParent;
  }

  return path;
}

export function analyzeGraph(graph: ParsedGraph): AnalysisResult {
  const { forward, reverse } = buildAdjLists(graph);
  const sccs = findSCCs(forward); // compute once, reuse
  const depths = computeDepths(forward, reverse);
  const transitiveCounts = computeTransitiveDepCounts(forward, sccs);
  const bridges = findBridges(reverse, graph.edges);
  const articulationPoints = findArticulationPoints(forward, reverse);
  const longestPath = findLongestPath(forward, reverse);
  const { phases: buildPhaseMap, grouped: buildPhases } = computeBuildPhases(forward, reverse, sccs);

  const articulationSet = new Set(articulationPoints);
  const nodeMetrics = new Map<string, NodeMetrics>();

  for (const node of graph.nodes) {
    const parents = reverse.get(node.id) ?? [];
    const children = forward.get(node.id) ?? [];

    nodeMetrics.set(node.id, {
      id: node.id,
      inDegree: parents.length,
      outDegree: children.length,
      depth: depths.get(node.id) ?? 0,
      buildPhase: buildPhaseMap.get(node.id) ?? 0,
      isLeaf: children.length === 0,
      isRoot: parents.length === 0,
      isBridge: articulationSet.has(node.id),
      uniqueParent: parents.length === 1 ? parents[0] : null,
      transitiveDepCount: transitiveCounts.get(node.id) ?? 0,
    });
  }

  // Package stats
  const packageStats = new Map<string, { nodeCount: number; edgeCount: number }>();
  for (const node of graph.nodes) {
    const pkg = node.package;
    const stats = packageStats.get(pkg) ?? { nodeCount: 0, edgeCount: 0 };
    stats.nodeCount++;
    packageStats.set(pkg, stats);
  }
  // Build id->package lookup (O(V)) instead of find() per edge (O(V*E))
  const nodePackage = new Map<string, string>();
  for (const node of graph.nodes) nodePackage.set(node.id, node.package);

  for (const edge of graph.edges) {
    const pkg = nodePackage.get(edge.source);
    if (pkg) {
      const stats = packageStats.get(pkg) ?? { nodeCount: 0, edgeCount: 0 };
      stats.edgeCount++;
      packageStats.set(pkg, stats);
    }
  }

  const rootCandidates = graph.nodes.filter(n => (reverse.get(n.id)?.length ?? 0) === 0).map(n => n.id);
  const leaves = graph.nodes.filter(n => (forward.get(n.id)?.length ?? 0) === 0).map(n => n.id);

  // Sort roots by BFS reachable count — the real root reaches the most nodes
  const rootReachable = new Map<string, number>();
  for (const r of rootCandidates) {
    rootReachable.set(r, bfsFromRoots(forward, [r], null).size);
  }
  const roots = rootCandidates.sort((a, b) => (rootReachable.get(b) ?? 0) - (rootReachable.get(a) ?? 0));
  const totalDeps = Math.max(0, graph.nodes.length - 1);

  const heavyNodes = Array.from(transitiveCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id]) => id);

  return {
    nodeMetrics,
    bridges,
    articulationPoints,
    longestPath,
    heavyNodes,
    packageStats,
    roots,
    leaves,
    buildPhases,
    totalDeps,
  };
}

export interface RemovalImpact {
  id: string;
  orphanedCount: number;      // nodes that become unreachable
  savings: number;            // total reachable before - after
  savingsPct: number;
}

/**
 * Compute removal impact for all non-root, non-leaf nodes.
 * For each node, BFS from roots excluding that node and count how many
 * nodes become unreachable.
 * O(V * (V+E)) — call on demand, not during initial analysis.
 */
export function computeRemovalImpacts(graph: ParsedGraph, analysis: AnalysisResult): RemovalImpact[] {
  const forward: AdjList = new Map();
  for (const node of graph.nodes) forward.set(node.id, []);
  for (const edge of graph.edges) forward.get(edge.source)?.push(edge.target);

  const rootSet = new Set(analysis.roots);
  const leafSet = new Set(analysis.leaves);

  // Baseline: BFS from roots with nothing removed
  const baseline = bfsFromRoots(forward, analysis.roots, null);
  const baselineCount = baseline.size;

  // Only test nodes that are not roots and not leaves (leaves have 0 impact)
  const candidates = graph.nodes
    .filter(n => !rootSet.has(n.id) && !leafSet.has(n.id))
    .map(n => n.id);

  const results: RemovalImpact[] = [];

  for (const nodeId of candidates) {
    const reachable = bfsFromRoots(forward, analysis.roots, nodeId);
    const afterCount = reachable.size;
    const savings = baselineCount - afterCount;
    if (savings > 0) {
      results.push({
        id: nodeId,
        orphanedCount: savings - 1, // -1 for the removed node itself
        savings,
        savingsPct: baselineCount > 0 ? (savings / baselineCount) * 100 : 0,
      });
    }
  }

  results.sort((a, b) => b.savings - a.savings);
  return results;
}

function bfsFromRoots(forward: AdjList, roots: string[], excludeNode: string | null): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];
  let head = 0; // index pointer — avoids O(n) shift()

  for (const root of roots) {
    if (root === excludeNode) continue;
    reachable.add(root);
    queue.push(root);
  }

  while (head < queue.length) {
    const cur = queue[head++];
    for (const child of forward.get(cur) ?? []) {
      if (child !== excludeNode && !reachable.has(child)) {
        reachable.add(child);
        queue.push(child);
      }
    }
  }

  return reachable;
}

/**
 * BFS shortest path, optionally excluding nodes and/or edges.
 */
/**
 * Suffix deduplication: remove paths that are extensions of shorter paths.
 * If path B ends with the entirety of path A, B is redundant.
 * e.g. [k,t,a,b,c,e] is redundant when [a,b,c,e] exists.
 */
function deduplicatePaths(paths: string[][]): string[][] {
  if (paths.length <= 1) return paths;

  // Reverse paths and sort lexicographically — suffix-subsumed paths become prefix-subsumed
  const reversed = paths.map((p, i) => ({ rev: [...p].reverse(), idx: i }));
  reversed.sort((a, b) => {
    const len = Math.min(a.rev.length, b.rev.length);
    for (let i = 0; i < len; i++) {
      if (a.rev[i] < b.rev[i]) return -1;
      if (a.rev[i] > b.rev[i]) return 1;
    }
    return a.rev.length - b.rev.length; // shorter first
  });

  const keep = new Set<number>();
  for (let i = 0; i < reversed.length; i++) {
    // Check if this reversed path is a prefix of the next one (meaning next is a suffix extension)
    let subsumed = false;
    // Check against all previous kept paths
    for (const ki of keep) {
      const kept = reversed.find(r => r.idx === ki)!;
      if (kept.rev.length <= reversed[i].rev.length) {
        let isPrefix = true;
        for (let j = 0; j < kept.rev.length; j++) {
          if (kept.rev[j] !== reversed[i].rev[j]) { isPrefix = false; break; }
        }
        if (isPrefix && kept.rev.length < reversed[i].rev.length) {
          subsumed = true;
          break;
        }
      }
    }
    if (!subsumed) keep.add(reversed[i].idx);
  }

  return paths.filter((_, i) => keep.has(i));
}

/**
 * Find dominator nodes: nodes that appear on EVERY path from `from` to `to`.
 * Cutting any single dominator breaks all paths.
 * O(P * L) where P = paths, L = max length.
 */
function findDominatorNodes(paths: string[][], from: string, to: string): string[] {
  if (paths.length === 0) return [];

  // Start with all intermediate nodes from first path
  let candidates = new Set(paths[0].slice(1, -1));

  // Intersect with each subsequent path
  for (let i = 1; i < paths.length; i++) {
    const pathNodes = new Set(paths[i].slice(1, -1));
    for (const node of candidates) {
      if (!pathNodes.has(node)) candidates.delete(node);
    }
    if (candidates.size === 0) break;
  }

  // Sort by position in shortest path (first path)
  const order = new Map(paths[0].map((n, i) => [n, i]));
  return Array.from(candidates).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * Exact min vertex cut via max-flow on node-split graph.
 * Uses Edmonds-Karp (BFS-based Ford-Fulkerson).
 * Returns the minimum set of intermediate nodes to remove to disconnect from→to.
 */
function computeMinVertexCut(
  forward: AdjList,
  from: string,
  to: string
): { cutSize: number; cutNodes: string[] } {
  // Build the subgraph of nodes reachable from `from` that can reach `to`
  // Forward reachable from `from`
  const fwdReach = new Set<string>();
  let q: string[] = [from]; let h = 0;
  fwdReach.add(from);
  while (h < q.length) {
    const cur = q[h++];
    for (const child of forward.get(cur) ?? []) {
      if (!fwdReach.has(child)) { fwdReach.add(child); q.push(child); }
    }
  }

  if (!fwdReach.has(to)) return { cutSize: 0, cutNodes: [] };

  // Backward reachable from `to`
  const reverse = new Map<string, string[]>();
  for (const [src, tgts] of forward) {
    for (const t of tgts) {
      if (!reverse.has(t)) reverse.set(t, []);
      reverse.get(t)!.push(src);
    }
  }
  const bwdReach = new Set<string>();
  q = [to]; h = 0;
  bwdReach.add(to);
  while (h < q.length) {
    const cur = q[h++];
    for (const parent of reverse.get(cur) ?? []) {
      if (!bwdReach.has(parent)) { bwdReach.add(parent); q.push(parent); }
    }
  }

  // Relevant nodes: on some path from→to
  const relevant = new Set<string>();
  for (const n of fwdReach) { if (bwdReach.has(n)) relevant.add(n); }

  // Node splitting: each node v becomes v_in and v_out
  // Edge v_in → v_out with capacity 1 (except from/to which get infinity)
  // Original edges: u_out → v_in with capacity infinity
  type FlowNode = string;
  const nodeIn = (n: string): FlowNode => n + '<<in';
  const nodeOut = (n: string): FlowNode => n + '<<out';

  const cap = new Map<string, number>(); // edge key → capacity
  const flowAdj = new Map<FlowNode, FlowNode[]>();
  const INF = relevant.size + 1;

  const ensureAdj = (n: FlowNode) => { if (!flowAdj.has(n)) flowAdj.set(n, []); };

  for (const n of relevant) {
    const ni = nodeIn(n), no = nodeOut(n);
    ensureAdj(ni); ensureAdj(no);
    // Internal edge: capacity 1 for intermediates, INF for from/to
    const c = (n === from || n === to) ? INF : 1;
    const ek = `${ni}|||${no}`;
    cap.set(ek, c);
    flowAdj.get(ni)!.push(no);
    // Reverse edge for residual graph
    const rek = `${no}|||${ni}`;
    cap.set(rek, 0);
    flowAdj.get(no)!.push(ni);
  }

  for (const n of relevant) {
    for (const child of forward.get(n) ?? []) {
      if (!relevant.has(child)) continue;
      const no = nodeOut(n), ci = nodeIn(child);
      ensureAdj(no); ensureAdj(ci);
      const ek = `${no}|||${ci}`;
      cap.set(ek, INF);
      flowAdj.get(no)!.push(ci);
      const rek = `${ci}|||${no}`;
      if (!cap.has(rek)) {
        cap.set(rek, 0);
        flowAdj.get(ci)!.push(no);
      }
    }
  }

  // Edmonds-Karp: BFS to find augmenting paths
  const source = nodeOut(from);
  const sink = nodeIn(to);
  let totalFlow = 0;

  while (totalFlow < INF) {
    // BFS for augmenting path
    const parent = new Map<FlowNode, FlowNode>();
    const visited = new Set<FlowNode>([source]);
    const bfsQ: FlowNode[] = [source];
    let bh = 0;
    let found = false;

    while (bh < bfsQ.length) {
      const cur = bfsQ[bh++];
      for (const next of flowAdj.get(cur) ?? []) {
        const ek = `${cur}|||${next}`;
        if (!visited.has(next) && (cap.get(ek) ?? 0) > 0) {
          visited.add(next);
          parent.set(next, cur);
          if (next === sink) { found = true; break; }
          bfsQ.push(next);
        }
      }
      if (found) break;
    }

    if (!found) break;

    // Find bottleneck
    let bottleneck = INF;
    let cur: FlowNode = sink;
    while (cur !== source) {
      const prev = parent.get(cur)!;
      const ek = `${prev}|||${cur}`;
      bottleneck = Math.min(bottleneck, cap.get(ek) ?? 0);
      cur = prev;
    }

    // Update residual
    cur = sink;
    while (cur !== source) {
      const prev = parent.get(cur)!;
      const ek = `${prev}|||${cur}`;
      const rek = `${cur}|||${prev}`;
      cap.set(ek, (cap.get(ek) ?? 0) - bottleneck);
      cap.set(rek, (cap.get(rek) ?? 0) + bottleneck);
      cur = prev;
    }

    totalFlow += bottleneck;
  }

  // Find min-cut nodes: nodes whose internal edge (in→out) is saturated
  // and in_node is reachable from source in residual, but out_node is not
  const residualReach = new Set<FlowNode>([source]);
  q = [source]; h = 0;
  while (h < q.length) {
    const cur = q[h++];
    for (const next of flowAdj.get(cur) ?? []) {
      const ek = `${cur}|||${next}`;
      if (!residualReach.has(next) && (cap.get(ek) ?? 0) > 0) {
        residualReach.add(next);
        q.push(next);
      }
    }
  }

  const cutNodes: string[] = [];
  for (const n of relevant) {
    if (n === from || n === to) continue;
    const ni = nodeIn(n), no = nodeOut(n);
    if (residualReach.has(ni) && !residualReach.has(no)) {
      cutNodes.push(n);
    }
  }

  return { cutSize: totalFlow, cutNodes };
}

/**
 * Group paths by first divergence from shortest path.
 */
function groupPathsByDivergence(paths: string[][], shortest: string[]): PathGroup[] {
  if (paths.length <= 1) {
    return paths.length === 1 ? [{ viaNode: paths[0][1] ?? paths[0][0], paths, representative: paths[0] }] : [];
  }

  // For each path, find where it first diverges from the shortest
  const groups = new Map<string, string[][]>();
  const shortestNodes = new Map(shortest.map((n, i) => [n, i]));

  for (const path of paths) {
    let divergeNode = path[1] ?? path[0]; // default: second node
    for (let i = 1; i < path.length - 1; i++) {
      if (!shortestNodes.has(path[i])) {
        divergeNode = path[i];
        break;
      }
    }
    const arr = groups.get(divergeNode) ?? [];
    arr.push(path);
    groups.set(divergeNode, arr);
  }

  return Array.from(groups.entries())
    .map(([viaNode, paths]) => ({
      viaNode,
      paths,
      representative: paths.reduce((a, b) => a.length <= b.length ? a : b, paths[0]),
    }))
    .sort((a, b) => a.representative.length - b.representative.length);
}

function bfsPath(
  forward: AdjList,
  from: string,
  to: string,
  excludeNodes?: Set<string>,
  excludeEdges?: Set<string>
): string[] | null {
  if (from === to) return [from];

  const visited = new Set<string>([from]);
  const parent = new Map<string, string>();
  const queue = [from];
  let bh = 0;

  while (bh < queue.length) {
    const current = queue[bh++];;
    for (const child of forward.get(current) ?? []) {
      if (visited.has(child)) continue;
      if (excludeNodes?.has(child) && child !== to) continue;
      if (excludeEdges?.has(`${current}|||${child}`)) continue;

      visited.add(child);
      parent.set(child, current);

      if (child === to) {
        const path: string[] = [to];
        let cur = to;
        while (cur !== from) {
          cur = parent.get(cur)!;
          path.unshift(cur);
        }
        return path;
      }

      queue.push(child);
    }
  }

  return null;
}

/**
 * Yen's K-shortest paths algorithm.
 * Finds K diverse shortest paths from `from` to `to`.
 * Each iteration detours around a node in the previous path,
 * producing genuinely different routes.
 * O(K * V * (V+E)) — fast for K <= 20.
 */
function yenKShortest(
  forward: AdjList,
  from: string,
  to: string,
  K: number,
  timeLimitMs: number = 2000
): string[][] {
  const A: string[][] = [];
  const B: { path: string[]; len: number }[] = [];
  const seen = new Set<string>();
  const t0 = Date.now();

  const first = bfsPath(forward, from, to);
  if (!first) return [];
  A.push(first);
  seen.add(first.join('→'));

  for (let k = 1; k < K; k++) {
    if (Date.now() - t0 > timeLimitMs) break; // time limit

    const prevPath = A[k - 1];

    for (let i = 0; i < prevPath.length - 1; i++) {
      if (Date.now() - t0 > timeLimitMs) break;

      const excludeEdges = new Set<string>();
      for (const p of A) {
        if (p.length <= i) continue;
        let prefixMatch = true;
        for (let x = 0; x <= i; x++) {
          if (p[x] !== prevPath[x]) { prefixMatch = false; break; }
        }
        if (prefixMatch) {
          excludeEdges.add(`${p[i]}|||${p[i + 1]}`);
        }
      }

      const excludeNodes = new Set<string>();
      for (let j = 0; j < i; j++) {
        excludeNodes.add(prevPath[j]);
      }

      const spurPath = bfsPath(forward, prevPath[i], to, excludeNodes, excludeEdges);
      if (spurPath) {
        const totalPath = [...prevPath.slice(0, i), ...spurPath];
        const pathKey = totalPath.join('→');
        if (!seen.has(pathKey)) {
          seen.add(pathKey);
          B.push({ path: totalPath, len: totalPath.length });
        }
      }
    }

    if (B.length === 0) break;

    B.sort((a, b) => a.len - b.len);
    A.push(B.shift()!.path);
  }

  return A;
}

/**
 * Find diverse paths by avoiding key nodes from previous paths.
 * For each intermediate node in the shortest path, try finding a route
 * that skips that node entirely — this discovers paths through
 * completely different parts of the graph.
 */
/**
 * Find diverse paths by iteratively blocking intermediates.
 * Each new path reveals new nodes to block, which discovers more paths.
 * Keeps going until no new paths are found or time runs out.
 */
function findDiversePaths(
  forward: AdjList,
  from: string,
  to: string,
  shortestPath: string[],
  timeLimitMs: number
): string[][] {
  const paths: string[][] = [];
  const seen = new Set<string>();
  seen.add(shortestPath.join('→'));
  const t0 = Date.now();

  // Collect all intermediates to try blocking — start with shortest, grow as we find more
  const triedNodes = new Set<string>();
  const queue = [...shortestPath.slice(1, -1)]; // start with shortest path's intermediates

  while (queue.length > 0 && Date.now() - t0 < timeLimitMs) {
    const blocked = queue.shift()!;
    if (triedNodes.has(blocked)) continue;
    triedNodes.add(blocked);

    const path = bfsPath(forward, from, to, new Set([blocked]));
    if (!path) continue;

    const key = path.join('→');
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(path);

      // Add this path's intermediates to the queue — they'll reveal more routes
      for (const node of path.slice(1, -1)) {
        if (!triedNodes.has(node)) queue.push(node);
      }
    }

    // Also try blocking pairs: this node + each intermediate from found paths
    for (const path2Source of [shortestPath, ...paths.slice(-3)]) {
      if (Date.now() - t0 > timeLimitMs) break;
      for (const blocked2 of path2Source.slice(1, -1)) {
        if (blocked2 === blocked) continue;
        if (Date.now() - t0 > timeLimitMs) break;

        const path2 = bfsPath(forward, from, to, new Set([blocked, blocked2]));
        if (path2) {
          const key2 = path2.join('→');
          if (!seen.has(key2)) {
            seen.add(key2);
            paths.push(path2);
            for (const node of path2.slice(1, -1)) {
              if (!triedNodes.has(node)) queue.push(node);
            }
          }
        }
      }
    }
  }

  return paths;
}

/**
 * Find paths from `from` to `to` with full analysis:
 * 1. Discover paths (diverse + Yen's K-shortest)
 * 2. Suffix deduplication (remove redundant extensions)
 * 3. Dominator analysis (nodes on ALL paths)
 * 4. Min vertex cut (exact minimum nodes to remove)
 * 5. Group by first divergence point
 */
export function findAllPaths(
  graph: ParsedGraph,
  from: string,
  to: string,
): PathInfo {
  const forward: AdjList = new Map();
  for (const node of graph.nodes) forward.set(node.id, []);
  for (const edge of graph.edges) forward.get(edge.source)?.push(edge.target);
  // Sort adjacency lists for deterministic BFS results across sessions
  for (const [, children] of forward) children.sort();

  const empty: PathInfo = {
    from, to, shortestPath: [], essentialPaths: [], allPathCount: 0,
    dominators: [], minCutNodes: [], minCutSize: 0,
    pathGroups: [], isUnique: false, reachable: false,
  };

  // Validate nodes exist
  if (!forward.has(from) || !forward.has(to)) return empty;

  // 1. Shortest path
  const shortest = bfsPath(forward, from, to);
  if (!shortest) return empty;

  // 2. Discover diverse paths + Yen's variations
  const diversePaths = findDiversePaths(forward, from, to, shortest, 8000);
  const yenPaths = yenKShortest(forward, from, to, 30, 4000);

  // Merge and dedup
  const allPathKeys = new Set<string>();
  const rawPaths: string[][] = [];
  for (const p of [shortest, ...diversePaths, ...yenPaths]) {
    const key = p.join('→');
    if (!allPathKeys.has(key)) {
      allPathKeys.add(key);
      rawPaths.push(p);
    }
  }

  const allPathCount = rawPaths.length;

  // 3. Suffix deduplication
  const essentialPaths = deduplicatePaths(rawPaths);

  // 4. Dominator analysis — nodes on ALL essential paths
  const dominators = findDominatorNodes(essentialPaths, from, to);

  // 5. Exact min vertex cut
  const { cutSize: minCutSize, cutNodes: minCutNodes } = computeMinVertexCut(forward, from, to);

  // 6. Group by first divergence
  const pathGroups = groupPathsByDivergence(essentialPaths, shortest);

  return {
    from,
    to,
    shortestPath: shortest,
    essentialPaths,
    allPathCount,
    dominators,
    minCutNodes,
    minCutSize,
    pathGroups,
    isUnique: essentialPaths.length === 1,
    reachable: true,
  };
}
