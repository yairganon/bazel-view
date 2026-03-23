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

export interface PathInfo {
  from: string;
  to: string;
  shortestPath: string[];
  allPaths: string[][];
  pathDag: Map<string, PathDagNode>;  // condensed view of all paths as a DAG
  branchPoints: string[];              // nodes where paths diverge
  independentCount: number;
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
  const roots = rootCandidates.sort((a, b) => {
    const ra = bfsFromRoots(forward, [a], null).size;
    const rb = bfsFromRoots(forward, [b], null).size;
    return rb - ra;
  });

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
 * Find paths from `from` to `to`:
 * 1. K-shortest diverse paths (Yen's algorithm)
 * 2. Edge-disjoint paths (completely different routes)
 * 3. Node-disjoint count (how many cuts needed)
 */
export function findAllPaths(
  graph: ParsedGraph,
  from: string,
  to: string,
): PathInfo {
  const forward: AdjList = new Map();
  for (const node of graph.nodes) forward.set(node.id, []);
  for (const edge of graph.edges) forward.get(edge.source)?.push(edge.target);

  // 1. Shortest path
  const shortest = bfsPath(forward, from, to);
  if (!shortest) {
    return {
      from, to, shortestPath: [], allPaths: [],
      pathDag: new Map(), branchPoints: [],
      independentCount: 0, isUnique: false, reachable: false,
    };
  }

  // 2. Diverse paths (block each intermediate node to find different routes)
  const diversePaths = findDiversePaths(forward, from, to, shortest, 8000);

  // 3. K-shortest paths (variations of shortest route)
  const yenPaths = yenKShortest(forward, from, to, 30, 4000);

  // Merge all: diverse paths first (most different), then Yen's (variations)
  const allPathKeys = new Set<string>();
  const allPaths: string[][] = [];

  for (const p of [shortest, ...diversePaths, ...yenPaths]) {
    const key = p.join('→');
    if (!allPathKeys.has(key)) {
      allPathKeys.add(key);
      allPaths.push(p);
    }
  }

  if (allPaths.length === 0) {
    return {
      from, to,
      shortestPath: [],
      allPaths: [],
      pathDag: new Map(),
      branchPoints: [],
      independentCount: 0,
      isUnique: false,
      reachable: false,
    };
  }

  // 2. Build path DAG — union of all path edges
  const dagChildren = new Map<string, Set<string>>();
  const dagParents = new Map<string, Set<string>>();
  const nodePathCount = new Map<string, number>();

  for (const path of allPaths) {
    // First pass: ensure all nodes have entries in maps
    for (const nodeId of path) {
      if (!dagChildren.has(nodeId)) dagChildren.set(nodeId, new Set());
      if (!dagParents.has(nodeId)) dagParents.set(nodeId, new Set());
      nodePathCount.set(nodeId, (nodePathCount.get(nodeId) ?? 0) + 1);
    }
    // Second pass: add edges
    for (let i = 0; i < path.length - 1; i++) {
      dagChildren.get(path[i])!.add(path[i + 1]);
      dagParents.get(path[i + 1])!.add(path[i]);
    }
  }

  const pathDag = new Map<string, PathDagNode>();
  const branchPoints: string[] = [];
  for (const [id, children] of dagChildren) {
    const childArr = Array.from(children);
    const parentCount = dagParents.get(id)?.size ?? 0;
    const isBranch = childArr.length > 1;
    const isMerge = parentCount > 1;
    if (isBranch) branchPoints.push(id);
    pathDag.set(id, {
      id,
      children: childArr,
      pathCount: nodePathCount.get(id) ?? 0,
      isBranch,
      isMerge,
    });
  }

  // 3. Node-disjoint count
  let disjointCount = 1;
  const excluded = new Set<string>();
  for (let i = 1; i < allPaths[0].length - 1; i++) excluded.add(allPaths[0][i]);
  for (let iter = 0; iter < 20; iter++) {
    const next = bfsPath(forward, from, to, excluded);
    if (!next) break;
    disjointCount++;
    for (let i = 1; i < next.length - 1; i++) excluded.add(next[i]);
  }

  return {
    from,
    to,
    shortestPath: allPaths[0],
    allPaths,
    pathDag,
    branchPoints,
    independentCount: disjointCount,
    isUnique: allPaths.length === 1,
    reachable: true,
  };
}
