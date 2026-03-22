import { useState, useCallback, useEffect } from 'react';
import { autoParseGraph, analyzeGraph } from './graph';
import type { ParsedGraph, AnalysisResult, FilterOptions } from './graph';
import GraphViewer from './components/GraphViewer';
import Sidebar from './components/Sidebar';
import ImportDialog from './components/ImportDialog';

const STORAGE_KEY = 'bazel-view-graph';

/**
 * Compact storage format: store node IDs as array, edges as index pairs.
 * "//very/long/path:target" repeated in edges bloats JSON.
 * Storing edges as [0,1],[0,2] instead of full strings saves ~60%.
 */
function saveToStorage(graph: ParsedGraph) {
  try {
    const nodeIds = graph.nodes.map(n => n.id);
    const idToIdx = new Map<string, number>();
    nodeIds.forEach((id, i) => idToIdx.set(id, i));

    const edgePairs = graph.edges.map(e => [idToIdx.get(e.source)!, idToIdx.get(e.target)!]);

    const payload = JSON.stringify({
      v: 2, // format version
      ids: nodeIds,
      pkg: graph.nodes.map(n => n.package),
      edges: edgePairs,
    });
    localStorage.setItem(STORAGE_KEY, payload);
  } catch { /* storage full — ignore */ }
}

function loadFromStorage(): ParsedGraph | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);

    if (data.v === 2) {
      const { ids, pkg, edges: edgePairs } = data;
      if (!ids || !edgePairs || ids.length === 0) return null;
      const nodes = ids.map((id: string, i: number) => ({
        id,
        label: id,
        package: pkg?.[i] ?? id,
      }));
      const edges = edgePairs.map(([s, t]: [number, number]) => ({
        source: ids[s],
        target: ids[t],
      }));
      return { nodes, edges };
    }

    // Legacy v1 format
    const { nodes, edges } = data;
    if (!nodes || !edges || nodes.length === 0) return null;
    return { nodes, edges };
  } catch { return null; }
}

function clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export default function App() {
  const [graph, setGraph] = useState<ParsedGraph | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [highlightedEdges, setHighlightedEdges] = useState<Set<string>>(new Set());
  const [highlightMode, setHighlightMode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Auto-load from localStorage on startup
  useEffect(() => {
    const saved = loadFromStorage();
    if (saved) {
      setLoading(true);
      setTimeout(() => {
        try {
          const result = analyzeGraph(saved);
          setGraph(saved);
          setAnalysis(result);
        } catch { /* corrupted — ignore */ }
        setLoading(false);
        setInitialized(true);
      }, 50);
    } else {
      setInitialized(true);
    }
  }, []);

  const handleImport = useCallback((data: string, filter: FilterOptions) => {
    setError(null);
    setLoading(true);

    setTimeout(() => {
      try {
        const parsed = autoParseGraph(data, filter);
        if (parsed.nodes.length === 0) {
          setError('No nodes found after filtering. Try adjusting filter options.');
          setLoading(false);
          return;
        }

        const result = analyzeGraph(parsed);
        setGraph(parsed);
        setAnalysis(result);
        setLoading(false);
        saveToStorage(parsed);
      } catch (e: any) {
        setError(`Parse error: ${e.message}`);
        setLoading(false);
      }
    }, 50);
  }, []);

  const handleHighlight = useCallback((nodes: Set<string>, edges: Set<string>, mode: string) => {
    setHighlightedNodes(nodes);
    setHighlightedEdges(edges);
    setHighlightMode(mode);
  }, []);

  const handleReset = () => {
    setGraph(null);
    setAnalysis(null);
    setSelectedNode(null);
    setHighlightedNodes(new Set());
    setHighlightedEdges(new Set());
    setHighlightMode('');
    setError(null);
    clearStorage();
  };

  if (!initialized) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!graph || !analysis) {
    return <ImportDialog onImport={handleImport} loading={loading} error={error} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold text-white">Bazel View</h1>
          <span className="text-xs text-gray-500">
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </span>
          {highlightMode && (
            <span className="text-xs px-2 py-0.5 bg-green-900 text-green-400 rounded">
              {highlightMode}: {highlightedNodes.size} nodes highlighted
            </span>
          )}
        </div>
        <button
          onClick={handleReset}
          className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
        >
          New graph
        </button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <GraphViewer
          graph={graph}
          analysis={analysis}
          selectedNode={selectedNode}
          onSelectNode={setSelectedNode}
          highlightedNodes={highlightedNodes}
          highlightedEdges={highlightedEdges}
        />
        <Sidebar
          graph={graph}
          analysis={analysis}
          selectedNode={selectedNode}
          onSelectNode={setSelectedNode}
          onHighlight={handleHighlight}
        />
      </div>
    </div>
  );
}
