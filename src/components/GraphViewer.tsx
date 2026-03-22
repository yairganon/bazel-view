import { useEffect, useRef, useState, useCallback } from 'react';
import type { ParsedGraph, AnalysisResult } from '../graph';
import {
  initPositions,
  forceLayoutTick,
  type LayoutType,
  type NodePosition,
} from '../renderer/layout';
import {
  render,
  buildHitTree,
  screenToWorld,
  type ViewState,
} from '../renderer/canvas';

interface Props {
  graph: ParsedGraph;
  analysis: AnalysisResult;
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  highlightedNodes: Set<string>;
  highlightedEdges: Set<string>;
}

const COLORS = {
  root: '#22d3ee',
  leaf: '#a78bfa',
  bridge: '#f97316',
  thirdParty: '#f472b6',
};

export default function GraphViewer({
  graph,
  analysis,
  selectedNode,
  onSelectNode,
  highlightedNodes,
  highlightedEdges,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef<Map<string, NodePosition>>(new Map());
  const viewRef = useRef<ViewState>({ offsetX: 0, offsetY: 0, zoom: 1 });
  const animRef = useRef<number>(0);
  const tickRef = useRef(0);
  const settledRef = useRef(false);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startOX: number; startOY: number } | null>(null);
  const hitTreeRef = useRef<ReturnType<typeof buildHitTree> | null>(null);

  const [layoutType, setLayoutType] = useState<LayoutType>('force');
  const [showLabels, setShowLabels] = useState(true);
  const [settled, setSettled] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Initialize layout
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    const positions = initPositions(graph, analysis, layoutType, w, h);
    positionsRef.current = positions;
    tickRef.current = 0;
    settledRef.current = layoutType !== 'force';

    // Fit view
    viewRef.current = { offsetX: 0, offsetY: 0, zoom: 1 };
    if (layoutType !== 'force') {
      fitView(canvas);
      hitTreeRef.current = buildHitTree(positions, graph.nodes.length, analysis);
    }

    setSettled(layoutType !== 'force');
    setTick(0);
  }, [graph, analysis, layoutType]);

  const fitView = useCallback((canvas: HTMLCanvasElement) => {
    const positions = positionsRef.current;
    if (positions.size === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of positions.values()) {
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.y > maxY) maxY = pos.y;
    }

    const pad = 60;
    const gw = maxX - minX + pad * 2;
    const gh = maxY - minY + pad * 2;
    const zoom = Math.min(canvas.clientWidth / gw, canvas.clientHeight / gh, 2);

    viewRef.current = {
      zoom,
      offsetX: (canvas.clientWidth - gw * zoom) / 2 - (minX - pad) * zoom,
      offsetY: (canvas.clientHeight - gh * zoom) / 2 - (minY - pad) * zoom,
    };
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    let running = true;

    const loop = () => {
      if (!running) return;

      // Handle resize
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
      }

      // Force layout ticks
      if (!settledRef.current && layoutType === 'force') {
        // Run multiple ticks per frame for speed
        const ticksPerFrame = graph.nodes.length > 1000 ? 2 : 5;
        for (let i = 0; i < ticksPerFrame; i++) {
          const done = forceLayoutTick(graph, positionsRef.current, tickRef.current);
          tickRef.current++;
          if (done) {
            settledRef.current = true;
            setSettled(true);
            break;
          }
        }

        // Auto-fit during early ticks
        if (tickRef.current % 20 === 0) {
          fitView(canvas);
        }

        // Update hit tree periodically
        if (tickRef.current % 30 === 0 || settledRef.current) {
          hitTreeRef.current = buildHitTree(positionsRef.current, graph.nodes.length, analysis);
        }

        setTick(tickRef.current);
      }

      // Render
      render(ctx, w, h, graph, analysis, positionsRef.current, viewRef.current, {
        selectedNode,
        hoveredNode: hoveredRef.current,
        highlightedNodes,
        highlightedEdges,
        showLabels,
        layoutType,
      });

      animRef.current = requestAnimationFrame(loop);
    };

    loop();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [graph, analysis, layoutType, selectedNode, highlightedNodes, highlightedEdges, showLabels, fitView]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    dragRef.current = {
      startX: sx,
      startY: sy,
      startOX: viewRef.current.offsetX,
      startOY: viewRef.current.offsetY,
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (dragRef.current) {
      viewRef.current.offsetX = dragRef.current.startOX + (sx - dragRef.current.startX);
      viewRef.current.offsetY = dragRef.current.startOY + (sy - dragRef.current.startY);
      return;
    }

    // Hover detection
    const world = screenToWorld(sx, sy, viewRef.current);
    const hitRadius = 15 / viewRef.current.zoom;
    const hit = hitTreeRef.current?.queryNearest(world.x, world.y, hitRadius);
    const newHovered = hit?.id ?? null;
    if (newHovered !== hoveredRef.current) {
      hoveredRef.current = newHovered;
      setHoveredNode(newHovered);
      canvas.style.cursor = newHovered ? 'pointer' : 'grab';
    }
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (dragRef.current) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dx = sx - dragRef.current.startX;
      const dy = sy - dragRef.current.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      dragRef.current = null;

      // If barely moved, treat as click
      if (dist < 5) {
        const world = screenToWorld(sx, sy, viewRef.current);
        const hitRadius = 15 / viewRef.current.zoom;
        const hit = hitTreeRef.current?.queryNearest(world.x, world.y, hitRadius);
        onSelectNode(hit?.id ?? null);
      }
    }
  }, [onSelectNode]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const view = viewRef.current;
    const newZoom = Math.max(0.01, Math.min(20, view.zoom * factor));

    // Zoom toward cursor
    view.offsetX = sx - (sx - view.offsetX) * (newZoom / view.zoom);
    view.offsetY = sy - (sy - view.offsetY) * (newZoom / view.zoom);
    view.zoom = newZoom;
  }, []);

  const handleFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) fitView(canvas);
  }, [fitView]);

  return (
    <div className="relative flex-1 h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { dragRef.current = null; }}
        onWheel={handleWheel}
      />

      {/* Controls */}
      <div className="absolute top-3 left-3 flex gap-1 flex-wrap">
        {(['force', 'phases', 'hierarchical', 'radial'] as LayoutType[]).map(name => (
          <button
            key={name}
            onClick={() => setLayoutType(name)}
            className={`px-2 py-1 text-xs rounded ${
              layoutType === name ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            {name}
          </button>
        ))}
        <button onClick={handleFit} className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-300 hover:bg-gray-700">
          fit
        </button>
        <button
          onClick={() => setShowLabels(l => !l)}
          className={`px-2 py-1 text-xs rounded ${showLabels ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
        >
          labels
        </button>
      </div>

      {/* Layout progress */}
      {layoutType === 'force' && !settled && (
        <div className="absolute top-12 left-3 bg-gray-800/90 rounded px-2 py-1 text-xs text-yellow-400">
          Laying out... tick {tick}
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 left-3 bg-gray-800/90 rounded p-2 text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: COLORS.root }} /> Root
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: COLORS.leaf }} /> Leaf
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: COLORS.bridge }} /> Bridge
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: COLORS.thirdParty }} /> External
        </div>
      </div>

      {/* Stats */}
      <div className="absolute top-3 right-3 bg-gray-800/90 rounded p-2 text-xs text-gray-300">
        <div>{graph.nodes.length} nodes · {graph.edges.length} edges</div>
        <div className="text-gray-500">zoom: {viewRef.current.zoom.toFixed(2)}x</div>
        {hoveredNode && <div className="text-blue-400 mt-1 max-w-[200px] truncate">{hoveredNode.replace(/^\/\//, '')}</div>}
      </div>
    </div>
  );
}
