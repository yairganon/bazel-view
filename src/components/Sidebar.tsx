import { useState, useMemo } from 'react';
import type { ParsedGraph, AnalysisResult, NodeMetrics, GraphEdge, RemovalImpact, PathInfo, PathDagNode } from '../graph';
import { findAllPaths, computeRemovalImpacts } from '../graph';
import Autocomplete from './Autocomplete';

type Tab = 'overview' | 'impact' | 'phases' | 'nodes' | 'paths' | 'heaviest';

interface Props {
  graph: ParsedGraph;
  analysis: AnalysisResult;
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  onHighlight: (nodes: Set<string>, edges: Set<string>, mode: string) => void;
}

function edgeId(e: GraphEdge): string {
  return `${e.source}|||${e.target}`;
}

function shortLabel(id: string): string {
  return id.replace(/^\/\//, '');
}

export default function Sidebar({ graph, analysis, selectedNode, onSelectNode, onHighlight }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'inDegree' | 'outDegree' | 'transitive' | 'name'>('inDegree');
  // Default "From" to the root with most transitive deps (the main build target)
  // roots[0] is already the one with most reachable nodes (sorted in analyzeGraph)
  const mainRoot = analysis.roots[0] ?? '';
  const [pathFrom, setPathFrom] = useState(mainRoot);
  // Reset when graph changes
  const [prevMainRoot, setPrevMainRoot] = useState(mainRoot);
  if (mainRoot !== prevMainRoot) {
    setPrevMainRoot(mainRoot);
    setPathFrom(mainRoot);
  }
  const [pathTo, setPathTo] = useState('');
  const [pathResult, setPathResult] = useState<ReturnType<typeof findAllPaths> | null>(null);
  const [activeRoute, setActiveRoute] = useState<number>(0);
  const [removalResult, setRemovalResult] = useState<{
    removedId: string;
    orphaned: string[];
    affectedEdges: number;
    depsBefore: number;         // total transitive deps of root before
    depsAfter: number;          // total transitive deps of root after
    savings: number;            // depsBefore - depsAfter
    savingsPct: number;
  } | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'roots' | 'leaves' | 'bridges' | 'unique'>('all');
  const [impactRanking, setImpactRanking] = useState<RemovalImpact[] | null>(null);
  const [computingImpact, setComputingImpact] = useState(false);

  const selectedMetrics = selectedNode ? analysis.nodeMetrics.get(selectedNode) : null;
  const nodeIds = useMemo(() => graph.nodes.map(n => n.id).sort(), [graph]);

  const sortedNodes = useMemo(() => {
    let nodes = Array.from(analysis.nodeMetrics.values());

    // Filter
    if (filterMode === 'roots') nodes = nodes.filter(n => n.isRoot);
    else if (filterMode === 'leaves') nodes = nodes.filter(n => n.isLeaf);
    else if (filterMode === 'bridges') nodes = nodes.filter(n => n.isBridge);
    else if (filterMode === 'unique') nodes = nodes.filter(n => n.uniqueParent !== null);

    // Search
    if (search) {
      const q = search.toLowerCase();
      nodes = nodes.filter(n => n.id.toLowerCase().includes(q));
    }

    // Sort
    switch (sortBy) {
      case 'inDegree': return nodes.sort((a, b) => b.inDegree - a.inDegree);
      case 'outDegree': return nodes.sort((a, b) => b.outDegree - a.outDegree);
      case 'transitive': return nodes.sort((a, b) => b.transitiveDepCount - a.transitiveDepCount);
      case 'name': return nodes.sort((a, b) => a.id.localeCompare(b.id));
    }
  }, [analysis, search, sortBy, filterMode]);

  const [findingPaths, setFindingPaths] = useState(false);
  const handleFindPaths = () => {
    if (!pathFrom || !pathTo) return;
    setFindingPaths(true);
    setPathResult(null);
    setTimeout(() => {
      const result = findAllPaths(graph, pathFrom, pathTo);
      setPathResult(result);
      setFindingPaths(false);
      if (result.shortestPath.length > 0) {
        handleHighlightPath(result.shortestPath);
      }
    }, 50);
  };

  const handleHighlightPath = (path: string[]) => {
    const nodes = new Set(path);
    const edges = new Set<string>();
    for (let i = 0; i < path.length - 1; i++) {
      edges.add(`${path[i]}|||${path[i + 1]}`);
    }
    onHighlight(nodes, edges, 'path');
  };

  const handleHighlightBridges = () => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const bridge of analysis.bridges) {
      nodes.add(bridge.source);
      nodes.add(bridge.target);
      edges.add(edgeId(bridge));
    }
    onHighlight(nodes, edges, 'bridges');
  };

  const handleHighlightLongestPath = () => {
    handleHighlightPath(analysis.longestPath);
  };

  const handleHighlightDeps = (nodeId: string, direction: 'deps' | 'rdeps') => {
    const nodes = new Set<string>([nodeId]);
    const edges = new Set<string>();

    const visit = (id: string) => {
      const relevantEdges = direction === 'deps'
        ? graph.edges.filter(e => e.source === id)
        : graph.edges.filter(e => e.target === id);

      for (const edge of relevantEdges) {
        const next = direction === 'deps' ? edge.target : edge.source;
        edges.add(edgeId(edge));
        if (!nodes.has(next)) {
          nodes.add(next);
          visit(next);
        }
      }
    };

    visit(nodeId);
    onHighlight(nodes, edges, direction);
  };

  const handleClearHighlight = () => {
    onHighlight(new Set(), new Set(), '');
  };

  // Build adjacency list once for fast BFS
  const forwardAdj = useMemo(() => {
    const adj = new Map<string, string[]>();
    for (const node of graph.nodes) adj.set(node.id, []);
    for (const edge of graph.edges) adj.get(edge.source)?.push(edge.target);
    return adj;
  }, [graph]);

  const handleSimulateRemoval = (nodeId: string) => {
    // BFS helper with index pointer (avoids O(n) shift)
    const bfs = (excludeId: string | null): Set<string> => {
      const reached = new Set<string>();
      const q: string[] = [];
      let h = 0;
      for (const root of analysis.roots) {
        if (root === excludeId) continue;
        reached.add(root);
        q.push(root);
      }
      while (h < q.length) {
        const cur = q[h++];
        for (const child of forwardAdj.get(cur) ?? []) {
          if (child !== excludeId && !reached.has(child)) {
            reached.add(child);
            q.push(child);
          }
        }
      }
      return reached;
    };

    const reachableBefore = bfs(null);
    const reachableAfter = bfs(nodeId);

    const orphaned = graph.nodes
      .map(n => n.id)
      .filter(id => id !== nodeId && reachableBefore.has(id) && !reachableAfter.has(id));

    let affectedEdges = 0;
    for (const edge of graph.edges) {
      if (edge.source === nodeId || edge.target === nodeId) affectedEdges++;
    }

    const depsBefore = reachableBefore.size;
    const depsAfter = reachableAfter.size;
    const savings = depsBefore - depsAfter;
    const savingsPct = depsBefore > 0 ? (savings / depsBefore) * 100 : 0;

    setRemovalResult({ removedId: nodeId, orphaned, affectedEdges, depsBefore, depsAfter, savings, savingsPct });

    // Highlight orphaned nodes
    const orphanSet = new Set(orphaned);
    orphanSet.add(nodeId);
    const edges = new Set<string>();
    for (const edge of graph.edges) {
      if (orphanSet.has(edge.source) || orphanSet.has(edge.target)) {
        edges.add(`${edge.source}|||${edge.target}`);
      }
    }
    onHighlight(orphanSet, edges, `remove ${shortLabel(nodeId)}`);
  };

  return (
    <div className="w-[50%] bg-gray-800 border-l border-gray-700 flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-gray-700">
        {(['overview', 'impact', 'phases', 'nodes', 'paths', 'heaviest'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-2 text-xs font-medium ${
              tab === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 text-sm space-y-3">
        {tab === 'overview' && (
          <OverviewTab
            graph={graph}
            analysis={analysis}
            selectedNode={selectedNode}
            onSelectNode={onSelectNode}
            onHighlight={onHighlight}
            onNavigate={setTab}
          />
        )}

        {tab === 'impact' && (
          <div className="space-y-3">
            <div className="text-xs text-gray-400">
              Which single node removal would shrink the build the most?
              Tests every non-root, non-leaf node.
            </div>
            {!impactRanking && (
              <button
                onClick={() => {
                  setComputingImpact(true);
                  setTimeout(() => {
                    const results = computeRemovalImpacts(graph, analysis);
                    setImpactRanking(results);
                    setComputingImpact(false);
                  }, 50);
                }}
                disabled={computingImpact}
                className="w-full px-3 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 font-medium"
              >
                {computingImpact ? 'Computing... (testing every node)' : 'Compute Impact Rankings'}
              </button>
            )}
            {impactRanking && impactRanking.length === 0 && (
              <div className="text-xs text-gray-500 bg-gray-900 rounded p-3">
                No single node removal has any impact — all deps have redundant paths.
              </div>
            )}
            {impactRanking && impactRanking.length > 0 && (
              <>
                <div className="bg-gray-900 rounded p-2 text-xs space-y-1">
                  <div className="flex justify-between text-gray-400">
                    <span>Nodes with impact</span>
                    <span className="font-mono text-white">{impactRanking.length}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Top removal saves</span>
                    <span className="font-mono text-red-400">
                      -{impactRanking[0].savings} ({impactRanking[0].savingsPct.toFixed(1)}%)
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {impactRanking.slice(0, 30).map((item, i) => {
                    const m = analysis.nodeMetrics.get(item.id);
                    return (
                      <button
                        key={item.id}
                        onClick={() => onSelectNode(item.id)}
                        className={`w-full text-left bg-gray-900 rounded-lg p-2.5 hover:bg-gray-800 transition-colors ${
                          item.id === selectedNode ? 'ring-1 ring-yellow-500' : ''
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-mono text-gray-500">#{i + 1}</span>
                              <span className="text-xs text-blue-400 truncate font-medium">{shortLabel(item.id)}</span>
                            </div>
                            <div className="text-[10px] text-gray-500 mt-0.5">
                              phase {m?.buildPhase} · {m?.inDegree} in · {m?.outDegree} out · {item.orphanedCount} orphaned
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-sm font-bold text-red-400">-{item.savings}</div>
                            <div className="text-[10px] text-gray-500">{item.savingsPct.toFixed(1)}%</div>
                          </div>
                        </div>
                        <div className="mt-1.5 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(100, item.savingsPct)}%` }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'phases' && (
          <PhasesTab
            graph={graph}
            analysis={analysis}
            selectedNode={selectedNode}
            onSelectNode={onSelectNode}
            onHighlight={onHighlight}
          />
        )}

        {tab === 'nodes' && (
          <div className="space-y-2">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search nodes..."
              className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-500"
            />

            <div className="flex gap-1 flex-wrap">
              {(['all', 'roots', 'leaves', 'bridges', 'unique'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilterMode(f)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    filterMode === f ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            <div className="flex gap-1">
              <span className="text-xs text-gray-500">Sort:</span>
              {(['inDegree', 'outDegree', 'transitive', 'name'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className={`px-1.5 py-0.5 text-xs rounded ${
                    sortBy === s ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  {s === 'inDegree' ? 'in' : s === 'outDegree' ? 'out' : s === 'transitive' ? 'trans' : 'name'}
                </button>
              ))}
            </div>

            <div className="text-xs text-gray-500">{sortedNodes.length} nodes</div>

            <div className="space-y-0.5 max-h-[calc(100vh-300px)] overflow-y-auto">
              {sortedNodes.map(n => (
                <NodeRow
                  key={n.id}
                  node={n}
                  isSelected={n.id === selectedNode}
                  onClick={() => onSelectNode(n.id)}
                />
              ))}
            </div>
          </div>
        )}

        {tab === 'paths' && (
          <div className="space-y-3">
            <Section title="Find Paths">
              <div className="space-y-2">
                <Autocomplete
                  label="From:"
                  value={pathFrom}
                  onChange={setPathFrom}
                  options={nodeIds}
                  analysis={analysis}
                  placeholder="Type to search... (try multiple words)"
                />
                <Autocomplete
                  label="To:"
                  value={pathTo}
                  onChange={setPathTo}
                  options={nodeIds}
                  analysis={analysis}
                  placeholder="Type to search... (try multiple words)"
                />
                <button
                  onClick={handleFindPaths}
                  disabled={!pathFrom || !pathTo || findingPaths}
                  className="w-full px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {findingPaths ? 'Searching...' : 'Find all paths'}
                </button>
              </div>
            </Section>

            {pathResult && (
              <PathResultView
                pathResult={pathResult}
                analysis={analysis}
                selectedNode={selectedNode}
                onSelectNode={onSelectNode}
                onHighlight={onHighlight}
              />
            )}

          </div>
        )}

        {tab === 'heaviest' && (
          <HeaviestTab graph={graph} analysis={analysis} selectedNode={selectedNode} onSelectNode={onSelectNode} />
        )}
      </div>

      {/* Node detail drawer — fixed at bottom */}
      {selectedMetrics && (
        <div className="border-t border-gray-700 bg-gray-900 max-h-[45%] flex flex-col shrink-0">
          {/* Drawer header — always visible */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-850 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                selectedMetrics.isRoot ? 'bg-cyan-400' :
                selectedMetrics.isLeaf ? 'bg-purple-400' :
                selectedMetrics.id.startsWith('@') ? 'bg-pink-400' :
                'bg-gray-400'
              }`} />
              <span className="text-xs font-medium text-yellow-400 truncate">{shortLabel(selectedMetrics.id)}</span>
            </div>
            <button
              onClick={() => { onSelectNode(null); setRemovalResult(null); }}
              className="text-gray-500 hover:text-white text-sm px-1.5 py-0.5 hover:bg-gray-700 rounded shrink-0"
            >
              ×
            </button>
          </div>

          {/* Drawer content — scrollable */}
          <div className="overflow-y-auto px-3 pb-3 space-y-2.5">
            {/* Stats row */}
            <div className="flex gap-3 text-[10px] text-gray-400 pt-1">
              <span>phase <span className="text-white font-mono">{selectedMetrics.buildPhase}</span></span>
              <span>in <span className="text-white font-mono">{selectedMetrics.inDegree}</span></span>
              <span>out <span className="text-white font-mono">{selectedMetrics.outDegree}</span></span>
              <span>deps <span className="text-white font-mono">{selectedMetrics.transitiveDepCount}</span></span>
            </div>

            {/* Tags */}
            {(selectedMetrics.isRoot || selectedMetrics.isLeaf || selectedMetrics.isBridge || selectedMetrics.uniqueParent) && (
              <div className="flex flex-wrap gap-1">
                {selectedMetrics.isRoot && <span className="px-1.5 py-0.5 bg-cyan-900 text-cyan-300 text-[10px] rounded">root</span>}
                {selectedMetrics.isLeaf && <span className="px-1.5 py-0.5 bg-purple-900 text-purple-300 text-[10px] rounded">leaf</span>}
                {selectedMetrics.isBridge && <span className="px-1.5 py-0.5 bg-orange-900 text-orange-300 text-[10px] rounded">bridge</span>}
                {selectedMetrics.uniqueParent && (
                  <span className="px-1.5 py-0.5 bg-green-900 text-green-300 text-[10px] rounded">
                    sole link via {shortLabel(selectedMetrics.uniqueParent)}
                  </span>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-1.5">
              <DrawerAction onClick={() => handleHighlightDeps(selectedMetrics.id, 'deps')}>deps</DrawerAction>
              <DrawerAction onClick={() => handleHighlightDeps(selectedMetrics.id, 'rdeps')}>rdeps</DrawerAction>
              <DrawerAction onClick={() => { setPathFrom(selectedMetrics.id); setTab('paths'); }}>path from</DrawerAction>
              <DrawerAction onClick={() => { setPathTo(selectedMetrics.id); setTab('paths'); }}>path to</DrawerAction>
              <DrawerAction variant="danger" onClick={() => handleSimulateRemoval(selectedMetrics.id)}>what if removed?</DrawerAction>
            </div>

            {/* Removal result */}
            {removalResult && removalResult.removedId === selectedMetrics.id && (
              <div className="bg-red-950/50 border border-red-900/30 rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold text-red-400">-{removalResult.savings}</span>
                    <span className="text-[10px] text-gray-500">{removalResult.savingsPct.toFixed(1)}% of build</span>
                  </div>
                  <div className="text-[10px] text-gray-500">{removalResult.depsBefore} → {removalResult.depsAfter}</div>
                </div>
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden flex">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${removalResult.depsBefore > 0 ? (removalResult.depsAfter / removalResult.depsBefore) * 100 : 0}%` }} />
                  <div className="h-full bg-red-500 rounded-full flex-1" />
                </div>
                {removalResult.orphaned.length === 0 ? (
                  <div className="text-[10px] text-green-400">All deps still reachable via other paths.</div>
                ) : (
                  <details className="text-[10px]">
                    <summary className="text-gray-400 cursor-pointer hover:text-gray-300">
                      {removalResult.orphaned.length} nodes drop out
                    </summary>
                    <div className="mt-1 max-h-24 overflow-y-auto space-y-0.5">
                      {removalResult.orphaned.map(id => (
                        <button
                          key={id}
                          onClick={() => onSelectNode(id)}
                          className="block text-red-400 hover:text-red-300 truncate w-full text-left"
                        >
                          {shortLabel(id)}
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{title}</h4>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-400">{label}</span>
      <span className="font-mono text-white">{value}</span>
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-200"
    >
      {children}
    </button>
  );
}

function DrawerAction({ onClick, children, variant }: { onClick: () => void; children: React.ReactNode; variant?: 'danger' }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-[11px] rounded transition-colors ${
        variant === 'danger'
          ? 'bg-red-900/60 text-red-300 hover:bg-red-900'
          : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
      }`}
    >
      {children}
    </button>
  );
}

function PathResultView({ pathResult, analysis, selectedNode, onSelectNode, onHighlight }: {
  pathResult: PathInfo;
  analysis: AnalysisResult;
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  onHighlight: (nodes: Set<string>, edges: Set<string>, mode: string) => void;
}) {
  const [activeRoute, setActiveRoute] = useState(0);

  if (!pathResult.reachable) {
    return (
      <div className="bg-gray-900 rounded-lg p-4 text-center">
        <div className="text-sm text-gray-400">No connection exists between these nodes.</div>
      </div>
    );
  }

  const highlightAllPaths = () => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const path of pathResult.allPaths) {
      for (let i = 0; i < path.length; i++) {
        nodes.add(path[i]);
        if (i < path.length - 1) edges.add(`${path[i]}|||${path[i + 1]}`);
      }
    }
    onHighlight(nodes, edges, 'all paths');
  };

  const highlightPath = (path: string[]) => {
    const nodes = new Set(path);
    const edges = new Set<string>();
    for (let i = 0; i < path.length - 1; i++) edges.add(`${path[i]}|||${path[i + 1]}`);
    onHighlight(nodes, edges, 'path');
  };

  // Build the DAG level-by-level for the flat view
  const dagLevels = useMemo(() => {
    const dag = pathResult.pathDag;
    if (dag.size === 0) return [];

    const levels: { nodes: string[]; isGap: boolean }[] = [];
    let current = new Set([pathResult.from]);
    const visited = new Set<string>();

    while (current.size > 0) {
      const levelNodes = Array.from(current);
      const isSinglePath = levelNodes.length === 1;
      levels.push({ nodes: levelNodes, isGap: false });
      for (const n of levelNodes) visited.add(n);

      // Collect next level: all children of current nodes that haven't been visited
      const next = new Set<string>();
      for (const nodeId of current) {
        const dagNode = dag.get(nodeId);
        if (dagNode) {
          for (const child of dagNode.children) {
            if (!visited.has(child)) next.add(child);
          }
        }
      }
      current = next;
    }

    return levels;
  }, [pathResult]);

  const totalPaths = pathResult.allPaths.length;

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className={`rounded-lg p-3 ${
        pathResult.isUnique ? 'bg-green-950 border border-green-900' : 'bg-yellow-950 border border-yellow-900'
      }`}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-baseline gap-2">
            <span className={`text-lg font-bold ${pathResult.isUnique ? 'text-green-400' : 'text-yellow-400'}`}>
              {totalPaths}
            </span>
            <span className={`text-sm ${pathResult.isUnique ? 'text-green-300' : 'text-yellow-300'}`}>
              {totalPaths === 1 ? 'path' : 'paths'}
            </span>
          </div>
          <div className="text-xs text-gray-500">
            {pathResult.shortestPath.length} hops shortest
          </div>
        </div>
        <div className="text-xs text-gray-400">
          {pathResult.isUnique
            ? 'Only one route — cut any intermediate node to break this dep.'
            : `${pathResult.independentCount} independent route${pathResult.independentCount > 1 ? 's' : ''} — need to cut all to fully remove.`
          }
        </div>
        {pathResult.branchPoints.length > 0 && (
          <div className="text-xs text-gray-500 mt-1">
            {pathResult.branchPoints.length} branch point{pathResult.branchPoints.length > 1 ? 's' : ''} where paths diverge
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-1.5">
        <button onClick={highlightAllPaths} className="flex-1 px-2 py-1.5 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600">
          Highlight all paths
        </button>
        <button
          onClick={() => highlightPath(pathResult.shortestPath)}
          className="flex-1 px-2 py-1.5 text-xs bg-blue-800 text-blue-200 rounded hover:bg-blue-700"
        >
          Highlight shortest
        </button>
      </div>

      {/* DAG flow view — level by level */}
      <div className="bg-gray-900 rounded-lg overflow-hidden">
        {dagLevels.map((level, li) => {
          const isFirst = li === 0;
          const isLast = li === dagLevels.length - 1;

          return (
            <div key={li}>
              {/* Connector between levels */}
              {li > 0 && (
                <div className="flex justify-center py-0.5">
                  <div className="w-0.5 h-3 bg-gray-700" />
                </div>
              )}

              {/* Single node — clean row */}
              {level.nodes.length === 1 && (
                <button
                  onClick={() => onSelectNode(level.nodes[0])}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-gray-800 ${
                    level.nodes[0] === selectedNode ? 'bg-yellow-900/20' : ''
                  }`}
                >
                  <div className={`w-3.5 h-3.5 rounded-full shrink-0 flex items-center justify-center text-[8px] font-bold ${
                    isFirst ? 'bg-cyan-500 text-cyan-950' :
                    isLast ? 'bg-purple-500 text-purple-950' :
                    'bg-gray-600 text-gray-300'
                  }`}>
                    {isFirst ? 'S' : isLast ? 'T' : ''}
                  </div>
                  <span className={`text-xs truncate flex-1 ${isFirst || isLast ? 'text-white font-medium' : 'text-gray-300'}`}>
                    {shortLabel(level.nodes[0])}
                  </span>
                  {isFirst && <span className="text-[9px] px-1 py-0.5 rounded bg-cyan-900 text-cyan-300 shrink-0">FROM</span>}
                  {isLast && <span className="text-[9px] px-1 py-0.5 rounded bg-purple-900 text-purple-300 shrink-0">TO</span>}
                  {(() => {
                    const dn = pathResult.pathDag.get(level.nodes[0]);
                    return dn && dn.pathCount < totalPaths && !isFirst && !isLast ? (
                      <span className="text-[9px] text-gray-600 shrink-0">{dn.pathCount}/{totalPaths}</span>
                    ) : null;
                  })()}
                </button>
              )}

              {/* Multiple nodes — branch point */}
              {level.nodes.length > 1 && (
                <div className="border-l-2 border-yellow-800/50 ml-4">
                  <div className="flex items-center gap-1.5 px-3 py-1 -ml-[9px]">
                    <div className="w-3.5 h-3.5 rounded-full bg-yellow-500 text-yellow-950 flex items-center justify-center text-[8px] font-bold shrink-0">
                      {level.nodes.length}
                    </div>
                    <span className="text-[10px] text-yellow-400">{level.nodes.length} alternatives</span>
                  </div>
                  {level.nodes.map(nodeId => {
                    const dn = pathResult.pathDag.get(nodeId);
                    return (
                      <button
                        key={nodeId}
                        onClick={() => onSelectNode(nodeId)}
                        className={`w-full text-left pl-5 pr-3 py-1 flex items-center gap-2 hover:bg-gray-800 text-xs ${
                          nodeId === selectedNode ? 'bg-yellow-900/20' : ''
                        }`}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-600 shrink-0" />
                        <span className="text-gray-300 truncate flex-1">{shortLabel(nodeId)}</span>
                        {dn && <span className="text-[9px] text-gray-600 shrink-0">{dn.pathCount}/{totalPaths}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Individual routes — collapsed */}
      {totalPaths > 1 && (
        <details className="text-xs">
          <summary className="text-gray-500 cursor-pointer hover:text-gray-300">
            Browse {totalPaths} individual routes
          </summary>
          <div className="mt-2 flex gap-1 mb-2 flex-wrap">
            {pathResult.allPaths.map((path, i) => (
              <button
                key={i}
                onClick={() => { setActiveRoute(i); highlightPath(path); }}
                className={`px-2 py-1 text-[10px] rounded ${
                  activeRoute === i ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          {pathResult.allPaths[activeRoute] && (
            <div className="bg-gray-800 rounded p-2 space-y-0.5">
              {pathResult.allPaths[activeRoute].map((nodeId, j) => (
                <div key={j} className="flex items-center text-[10px] text-gray-400">
                  {j > 0 && <span className="text-gray-600 mr-1">→</span>}
                  <button onClick={() => onSelectNode(nodeId)} className="text-blue-400 hover:text-blue-300 truncate">
                    {shortLabel(nodeId)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function OverviewTab({ graph, analysis, selectedNode, onSelectNode, onHighlight, onNavigate }: {
  graph: ParsedGraph; analysis: AnalysisResult; selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  onHighlight: (nodes: Set<string>, edges: Set<string>, mode: string) => void;
  onNavigate: (tab: Tab) => void;
}) {
  const bottleneckCount = useMemo(
    () => analysis.buildPhases.filter(p => p.isBottleneck).length,
    [analysis]
  );

  const maxPhase = analysis.buildPhases.length - 1;
  const maxParallel = Math.max(...analysis.buildPhases.map(p => p.nodes.length));

  return (
    <div className="space-y-4">
      {/* Key metrics grid */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-gray-900 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-white">{graph.nodes.length}</div>
          <div className="text-[10px] text-gray-500">nodes</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-white">{graph.edges.length}</div>
          <div className="text-[10px] text-gray-500">edges</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-white">{analysis.buildPhases.length}</div>
          <div className="text-[10px] text-gray-500">build phases</div>
        </div>
      </div>

      {/* Build health indicators */}
      <div className="space-y-1.5">
        <div className="text-xs text-gray-400 font-medium">Build Health</div>

        <div className="bg-gray-900 rounded-lg divide-y divide-gray-800">
          <HealthRow
            label="Max parallelism"
            value={`${maxParallel} targets`}
            status={maxParallel > 50 ? 'good' : maxParallel > 10 ? 'ok' : 'bad'}
          />
          <HealthRow
            label="Bottleneck phases"
            value={bottleneckCount === 0 ? 'None' : `${bottleneckCount} found`}
            status={bottleneckCount === 0 ? 'good' : 'bad'}
            onClick={() => onNavigate('phases')}
          />
          <HealthRow
            label="Critical chain"
            value={`${analysis.longestPath.length} hops`}
            status={analysis.longestPath.length < 20 ? 'good' : analysis.longestPath.length < 50 ? 'ok' : 'bad'}
          />
          <HealthRow
            label="Bridge edges"
            value={`${analysis.bridges.length} unique links`}
            status="neutral"
          />
        </div>
      </div>

      {/* Quick actions — styled as cards you tap */}
      <div className="space-y-1.5">
        <div className="text-xs text-gray-400 font-medium">Explore</div>
        <div className="grid grid-cols-2 gap-1.5">
          <QuickAction
            label="Critical chain"
            sub={`${analysis.longestPath.length} hops`}
            onClick={() => {
              const nodes = new Set(analysis.longestPath);
              const edges = new Set<string>();
              for (let i = 0; i < analysis.longestPath.length - 1; i++) {
                edges.add(`${analysis.longestPath[i]}|||${analysis.longestPath[i + 1]}`);
              }
              onHighlight(nodes, edges, 'critical chain');
            }}
          />
          <QuickAction
            label="Bridge edges"
            sub={`${analysis.bridges.length} edges`}
            onClick={() => {
              const nodes = new Set<string>();
              const edges = new Set<string>();
              for (const b of analysis.bridges) {
                nodes.add(b.source); nodes.add(b.target);
                edges.add(`${b.source}|||${b.target}`);
              }
              onHighlight(nodes, edges, 'bridges');
            }}
          />
          <QuickAction label="Build phases" sub={`${analysis.buildPhases.length} phases`} onClick={() => onNavigate('phases')} />
          <QuickAction label="Impact analysis" sub="what to remove" onClick={() => onNavigate('impact')} />
        </div>
      </div>

      {/* Top 5 heaviest — compact preview, links to full tab */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400 font-medium">Heaviest Deps</span>
          <button onClick={() => onNavigate('heaviest')} className="text-[10px] text-blue-400 hover:text-blue-300">
            View all →
          </button>
        </div>
        <div className="bg-gray-900 rounded-lg divide-y divide-gray-800">
          {analysis.heavyNodes.slice(0, 5).map((id, i) => {
            const m = analysis.nodeMetrics.get(id)!;
            const maxDeps = analysis.nodeMetrics.get(analysis.heavyNodes[0])?.transitiveDepCount || 1;
            const pct = (m.transitiveDepCount / maxDeps) * 100;
            return (
              <button
                key={id}
                onClick={() => onSelectNode(id)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-gray-800 ${
                  id === selectedNode ? 'bg-yellow-900/20' : ''
                }`}
              >
                <span className="text-[10px] font-mono text-gray-600 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-300 truncate">{shortLabel(id)}</div>
                  <div className="mt-0.5 h-1 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500/60 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span className="text-[10px] font-mono text-gray-500 shrink-0">{m.transitiveDepCount}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Root target */}
      {(() => {
        // Real root = the one with the most transitive deps
        const sorted = [...analysis.roots].sort((a, b) =>
          (analysis.nodeMetrics.get(b)?.transitiveDepCount ?? 0) -
          (analysis.nodeMetrics.get(a)?.transitiveDepCount ?? 0)
        );
        const mainRoot = sorted[0];
        const orphanedRoots = sorted.slice(1);
        const mainMetrics = mainRoot ? analysis.nodeMetrics.get(mainRoot) : null;

        return (
          <div className="space-y-1.5">
            <div className="text-xs text-gray-400 font-medium">Root Target</div>
            {mainRoot && (
              <button
                onClick={() => onSelectNode(mainRoot)}
                className={`w-full text-left bg-gray-900 rounded-lg p-3 hover:bg-gray-800 ${
                  mainRoot === selectedNode ? 'ring-1 ring-yellow-500' : ''
                }`}
              >
                <div className="text-xs text-cyan-400 font-medium truncate">{shortLabel(mainRoot)}</div>
                {mainMetrics && (
                  <div className="text-[10px] text-gray-500 mt-1">
                    {mainMetrics.transitiveDepCount} transitive deps · phase {mainMetrics.buildPhase} · {mainMetrics.outDegree} direct deps
                  </div>
                )}
              </button>
            )}
            {orphanedRoots.length > 0 && (
              <details className="text-xs">
                <summary className="text-gray-600 cursor-pointer hover:text-gray-400">
                  {orphanedRoots.length} orphaned by filter
                </summary>
                <div className="mt-1 text-[10px] text-gray-600 mb-1">
                  These appear as roots because their parent was excluded by the filter.
                </div>
                <div className="bg-gray-900 rounded-lg divide-y divide-gray-800">
                  {orphanedRoots.map(id => (
                    <button
                      key={id}
                      onClick={() => onSelectNode(id)}
                      className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-800 truncate"
                    >
                      {shortLabel(id)}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })()}

      {/* Clear highlights */}
      <button
        onClick={() => onHighlight(new Set(), new Set(), '')}
        className="w-full text-left px-2 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-200"
      >
        Clear highlights
      </button>
    </div>
  );
}

function HealthRow({ label, value, status, onClick }: {
  label: string; value: string;
  status: 'good' | 'ok' | 'bad' | 'neutral';
  onClick?: () => void;
}) {
  const colors = {
    good: 'text-green-400',
    ok: 'text-yellow-400',
    bad: 'text-red-400',
    neutral: 'text-gray-300',
  };
  const dots = {
    good: 'bg-green-400',
    ok: 'bg-yellow-400',
    bad: 'bg-red-400',
    neutral: 'bg-gray-500',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`flex items-center justify-between px-3 py-2 ${onClick ? 'hover:bg-gray-800 cursor-pointer' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dots[status]}`} />
        <span className="text-xs text-gray-300">{label}</span>
      </div>
      <span className={`text-xs font-mono ${colors[status]}`}>{value}</span>
    </Tag>
  );
}

function QuickAction({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-gray-900 rounded-lg p-2.5 text-left hover:bg-gray-800 transition-colors"
    >
      <div className="text-xs text-gray-200">{label}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>
    </button>
  );
}

function PhasesTab({ graph, analysis, selectedNode, onSelectNode, onHighlight }: {
  graph: ParsedGraph; analysis: AnalysisResult; selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  onHighlight: (nodes: Set<string>, edges: Set<string>, mode: string) => void;
}) {
  const [expandedPhase, setExpandedPhase] = useState<number | null>(null);

  const { maxCount, bottlenecks } = useMemo(() => {
    const mc = Math.max(...analysis.buildPhases.map(p => p.nodes.length));
    const bn = analysis.buildPhases.filter(p => p.isBottleneck);
    return { maxCount: mc, bottlenecks: bn };
  }, [analysis]);

  const highlightPhase = (phase: { phase: number; nodes: string[] }) => {
    const nodes = new Set(phase.nodes);
    const edges = new Set<string>();
    for (const edge of graph.edges) {
      if (nodes.has(edge.source) || nodes.has(edge.target)) {
        edges.add(`${edge.source}|||${edge.target}`);
      }
    }
    onHighlight(nodes, edges, `phase ${phase.phase}`);
  };

  return (
    <div className="space-y-4">
      {/* Header stats — compact row */}
      <div className="flex gap-2">
        <div className="flex-1 bg-gray-900 rounded-lg p-2.5 text-center">
          <div className="text-lg font-bold text-white">{analysis.buildPhases.length}</div>
          <div className="text-[10px] text-gray-500">phases</div>
        </div>
        <div className="flex-1 bg-gray-900 rounded-lg p-2.5 text-center">
          <div className="text-lg font-bold text-white">{maxCount}</div>
          <div className="text-[10px] text-gray-500">max parallel</div>
        </div>
        <div className="flex-1 bg-gray-900 rounded-lg p-2.5 text-center">
          <div className={`text-lg font-bold ${bottlenecks.length > 0 ? 'text-red-400' : 'text-green-400'}`}>
            {bottlenecks.length}
          </div>
          <div className="text-[10px] text-gray-500">bottlenecks</div>
        </div>
      </div>

      {/* Waterfall timeline */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400 font-medium">Build Timeline</span>
          <span className="text-[10px] text-gray-600">click phase to highlight</span>
        </div>

        <div className="space-y-px">
          {analysis.buildPhases.map(phase => {
            const pct = (phase.nodes.length / maxCount) * 100;
            const isExpanded = expandedPhase === phase.phase;

            return (
              <div key={phase.phase}>
                <button
                  onClick={() => {
                    setExpandedPhase(isExpanded ? null : phase.phase);
                    highlightPhase(phase);
                  }}
                  className={`w-full text-left flex items-center gap-1.5 py-1 px-1 rounded transition-colors ${
                    isExpanded ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                  }`}
                >
                  {/* Phase number */}
                  <span className={`w-5 text-[10px] font-mono shrink-0 text-right ${
                    phase.isBottleneck ? 'text-red-400 font-bold' : 'text-gray-600'
                  }`}>
                    {phase.phase}
                  </span>

                  {/* Bar */}
                  <div className="flex-1 flex items-center gap-1.5">
                    <div className="flex-1 h-5 bg-gray-800 rounded-sm overflow-hidden relative">
                      <div
                        className={`h-full rounded-sm transition-all ${
                          phase.isBottleneck
                            ? 'bg-red-500/80'
                            : 'bg-blue-500/60'
                        }`}
                        style={{ width: `${Math.max(3, pct)}%` }}
                      />
                      {/* Inline label on the bar */}
                      <span className="absolute inset-0 flex items-center px-1.5 text-[10px] text-white/80 font-mono">
                        {phase.nodes.length}
                      </span>
                    </div>
                  </div>

                  {/* Waiting count */}
                  <span className="w-8 text-[10px] font-mono text-gray-600 text-right shrink-0">
                    {phase.waitingBehind > 0 ? phase.waitingBehind : ''}
                  </span>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="ml-7 mr-1 mb-1 bg-gray-900 rounded-lg overflow-hidden">
                    {/* Phase info bar */}
                    <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
                      <div className="text-xs text-gray-300">
                        Phase {phase.phase}
                        {phase.isBottleneck && (
                          <span className="ml-2 px-1.5 py-0.5 bg-red-900 text-red-300 rounded text-[10px]">
                            bottleneck · {phase.blockingRatio.toFixed(0)}x blocking
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {phase.waitingBehind > 0 && `${phase.waitingBehind} waiting`}
                      </div>
                    </div>

                    {/* Node list */}
                    <div className="max-h-48 overflow-y-auto">
                      {phase.nodes.map(id => {
                        const m = analysis.nodeMetrics.get(id);
                        return (
                          <button
                            key={id}
                            onClick={(e) => { e.stopPropagation(); onSelectNode(id); }}
                            className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-gray-800 ${
                              id === selectedNode ? 'bg-yellow-900/20' : ''
                            }`}
                          >
                            <span className="text-xs text-blue-400 truncate">{shortLabel(id)}</span>
                            <span className="text-[10px] text-gray-600 shrink-0 ml-2">
                              {m?.inDegree}↓ {m?.outDegree}↑
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend footer */}
        <div className="flex items-center justify-between mt-2 text-[10px] text-gray-600">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-blue-500/60 rounded-sm" /> parallel targets
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-red-500/80 rounded-sm" /> bottleneck
            </span>
          </div>
          <span>waiting →</span>
        </div>
      </div>

      {/* Clear highlights */}
      <button
        onClick={() => onHighlight(new Set(), new Set(), '')}
        className="w-full text-left px-2 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-200"
      >
        Clear highlights
      </button>
    </div>
  );
}

function HeaviestTab({ graph, analysis, selectedNode, onSelectNode }: {
  graph: ParsedGraph; analysis: AnalysisResult; selectedNode: string | null; onSelectNode: (id: string | null) => void;
}) {
  // Pre-compute expensive lookups once
  const { heaviestNodes, maxTransitive, parentIndex } = useMemo(() => {
    const all = Array.from(analysis.nodeMetrics.values())
      .sort((a, b) => b.transitiveDepCount - a.transitiveDepCount);
    const maxT = all[0]?.transitiveDepCount || 1;

    // Build reverse index: node -> list of parents
    const pIdx = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const arr = pIdx.get(edge.target);
      if (arr) arr.push(edge.source);
      else pIdx.set(edge.target, [edge.source]);
    }

    return { heaviestNodes: all.slice(0, 50), maxTransitive: maxT, parentIndex: pIdx };
  }, [graph, analysis]);

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-400">
        Deps sorted by how much weight they pull into the build.
      </div>
      {heaviestNodes.map((metrics, i) => {
        const parents = parentIndex.get(metrics.id) ?? [];
        const pct = (metrics.transitiveDepCount / maxTransitive) * 100;
        return (
          <button
            key={metrics.id}
            onClick={() => onSelectNode(metrics.id)}
            className={`w-full text-left bg-gray-900 rounded-lg p-2.5 hover:bg-gray-800 transition-colors ${
              metrics.id === selectedNode ? 'ring-1 ring-yellow-500' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-blue-400 truncate font-medium">{shortLabel(metrics.id)}</div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
                  <span>{metrics.transitiveDepCount} transitive deps</span>
                  <span>phase {metrics.buildPhase}</span>
                  <span>{metrics.inDegree} in</span>
                </div>
              </div>
              <span className="text-xs font-mono text-gray-400 shrink-0">#{i + 1}</span>
            </div>
            <div className="mt-1.5 h-1 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            {parents.length > 0 && (
              <div className="mt-1.5 text-[10px] text-gray-600">
                <span className="text-gray-500">pulled in by: </span>
                {parents.slice(0, 3).map((p, j) => (
                  <span key={p}>{j > 0 && ', '}<span className="text-gray-400">{shortLabel(p)}</span></span>
                ))}
                {parents.length > 3 && <span className="text-gray-600"> +{parents.length - 3} more</span>}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function NodeRow({ node, isSelected, onClick }: { node: NodeMetrics; isSelected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1 rounded text-xs flex items-center justify-between gap-1 ${
        isSelected ? 'bg-yellow-900/30 text-yellow-300' : 'hover:bg-gray-700 text-gray-300'
      }`}
    >
      <span className="truncate flex-1">{shortLabel(node.id)}</span>
      <span className="flex gap-1 text-gray-500 shrink-0">
        <span title="in-degree">↓{node.inDegree}</span>
        <span title="out-degree">↑{node.outDegree}</span>
      </span>
    </button>
  );
}
