/**
 * Canvas2D graph renderer. Handles:
 * - Pan/zoom
 * - Node rendering with color coding
 * - Edge rendering with optional arrows
 * - Hover detection via quadtree
 * - Highlight/dim effects
 * - Labels at zoom level
 */

import { QuadTree } from './quadtree';
import type { NodePosition } from './layout';
import type { ParsedGraph, AnalysisResult } from '../graph';

export interface ViewState {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export interface RenderOptions {
  selectedNode: string | null;
  hoveredNode: string | null;
  highlightedNodes: Set<string>;
  highlightedEdges: Set<string>;
  showLabels: boolean;
  layoutType: string;
}

const COLORS = {
  bg: '#111827',
  root: '#22d3ee',
  leaf: '#a78bfa',
  bridge: '#f97316',
  normal: '#6b7280',
  thirdParty: '#f472b6',
  selected: '#facc15',
  highlighted: '#34d399',
  edge: '#374151',
  edgeBridge: '#f97316',
  edgeHighlight: '#34d399',
  text: '#d1d5db',
  textDim: '#6b7280',
};

function nodeColor(id: string, metrics: AnalysisResult['nodeMetrics'] extends Map<string, infer V> ? V : never): string {
  if (id.includes('third_party') || id.startsWith('@')) return COLORS.thirdParty;
  if (metrics.isRoot) return COLORS.root;
  if (metrics.isLeaf) return COLORS.leaf;
  if (metrics.isBridge) return COLORS.bridge;
  return COLORS.normal;
}

function nodeRadius(inDegree: number, nodeCount: number): number {
  if (nodeCount > 1500) return Math.max(2, Math.min(10, 2 + inDegree * 0.15));
  if (nodeCount > 500) return Math.max(3, Math.min(14, 3 + inDegree * 0.5));
  return Math.max(5, Math.min(20, 5 + inDegree * 1.5));
}

// Phase-based color: blue (phase 0/leaves) → red (last phase/root)
const PHASE_COLORS = [
  '#3b82f6', '#2563eb', '#4f46e5', '#6d28d9', '#7c3aed',
  '#8b5cf6', '#a855f7', '#c026d3', '#db2777', '#e11d48',
  '#ef4444', '#f97316', '#eab308',
];

function phaseColor(phase: number, maxPhase: number): string {
  const idx = Math.round((phase / Math.max(maxPhase, 1)) * (PHASE_COLORS.length - 1));
  return PHASE_COLORS[Math.min(idx, PHASE_COLORS.length - 1)];
}

function drawPhaseLanes(
  ctx: CanvasRenderingContext2D,
  positions: Map<string, NodePosition>,
  analysis: AnalysisResult,
  zoom: number,
  nodeCount: number
) {
  // Compute Y bounds per phase
  const phaseBounds = new Map<number, { minY: number; maxY: number; count: number }>();
  let globalMinX = Infinity, globalMaxX = -Infinity;

  for (const [id, pos] of positions) {
    const m = analysis.nodeMetrics.get(id);
    if (!m) continue;
    const phase = m.buildPhase;
    const b = phaseBounds.get(phase) ?? { minY: Infinity, maxY: -Infinity, count: 0 };
    b.minY = Math.min(b.minY, pos.y);
    b.maxY = Math.max(b.maxY, pos.y);
    b.count++;
    phaseBounds.set(phase, b);
    globalMinX = Math.min(globalMinX, pos.x);
    globalMaxX = Math.max(globalMaxX, pos.x);
  }

  const maxPhase = Math.max(...Array.from(phaseBounds.keys()));
  const pad = 40;

  // Pre-build phase data map for O(1) lookup instead of O(n) find()
  const phaseDataMap = new Map(analysis.buildPhases.map(p => [p.phase, p]));

  // Draw lane backgrounds
  for (const [phase, bounds] of Array.from(phaseBounds.entries()).sort((a, b) => a[0] - b[0])) {
    const laneTop = bounds.minY - pad;
    const laneBottom = bounds.maxY + pad;
    const laneLeft = globalMinX - pad * 3;
    const laneRight = globalMaxX + pad * 3;

    // Alternating stripe background
    const color = phaseColor(phase, maxPhase);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.04;
    ctx.fillRect(laneLeft, laneTop, laneRight - laneLeft, laneBottom - laneTop);
    ctx.globalAlpha = 1;

    // Lane border
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.moveTo(laneLeft, laneTop);
    ctx.lineTo(laneRight, laneTop);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Phase label on the left
    const fontSize = Math.max(10, Math.min(16, 14 / zoom));
    ctx.font = `bold ${fontSize / zoom}px monospace`;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const centerY = (laneTop + laneBottom) / 2;
    ctx.fillText(`Phase ${phase}`, laneLeft - 8 / zoom, centerY);

    // Count label + bottleneck indicator
    const phaseData = phaseDataMap.get(phase);
    const isBottleneck = phaseData?.isBottleneck ?? false;
    ctx.font = `${(fontSize * 0.75) / zoom}px monospace`;
    ctx.globalAlpha = isBottleneck ? 0.8 : 0.35;
    if (isBottleneck) ctx.fillStyle = '#ef4444';
    ctx.fillText(
      `${bounds.count} target${bounds.count !== 1 ? 's' : ''}${isBottleneck ? ' ⚠ BOTTLENECK' : ''}`,
      laneLeft - 8 / zoom,
      centerY + fontSize / zoom
    );
    if (isBottleneck && phaseData) {
      ctx.font = `${(fontSize * 0.6) / zoom}px monospace`;
      ctx.globalAlpha = 0.5;
      ctx.fillText(
        `${phaseData.waitingBehind} waiting (${phaseData.blockingRatio.toFixed(1)}x)`,
        laneLeft - 8 / zoom,
        centerY + fontSize * 1.8 / zoom
      );
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
  }
}

export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  graph: ParsedGraph,
  analysis: AnalysisResult,
  positions: Map<string, NodePosition>,
  view: ViewState,
  options: RenderOptions
) {
  const { offsetX, offsetY, zoom } = view;
  const { selectedNode, hoveredNode, highlightedNodes, highlightedEdges, showLabels, layoutType } = options;
  const hasHighlights = highlightedNodes.size > 0 || highlightedEdges.size > 0;
  const nodeCount = graph.nodes.length;

  // Clear
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(zoom, zoom);

  // --- Phase lanes (only in phases layout) ---
  if (layoutType === 'phases' && analysis.buildPhases.length > 0) {
    drawPhaseLanes(ctx, positions, analysis, zoom, nodeCount);
  }

  // Build bridge edge set for fast lookup
  const bridgeSet = new Set<string>();
  for (const b of analysis.bridges) {
    bridgeSet.add(`${b.source}|||${b.target}`);
  }

  // --- Draw edges ---
  const edgeAlpha = hasHighlights ? 0.04 : (nodeCount > 1000 ? 0.15 : 0.3);
  const edgeWidth = nodeCount > 1000 ? 0.3 : 0.8;

  // Batch edges by type for fewer state changes
  // 1. Normal edges
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = edgeWidth / zoom;
  ctx.globalAlpha = edgeAlpha;
  ctx.beginPath();
  for (const edge of graph.edges) {
    const ek = `${edge.source}|||${edge.target}`;
    if (bridgeSet.has(ek)) continue;
    if (hasHighlights && highlightedEdges.has(ek)) continue;

    const sp = positions.get(edge.source);
    const tp = positions.get(edge.target);
    if (!sp || !tp) continue;

    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(tp.x, tp.y);
  }
  ctx.stroke();

  // 2. Bridge edges
  ctx.strokeStyle = COLORS.edgeBridge;
  ctx.lineWidth = (edgeWidth * 2) / zoom;
  ctx.globalAlpha = hasHighlights ? 0.08 : 0.5;
  ctx.setLineDash([4 / zoom, 3 / zoom]);
  ctx.beginPath();
  for (const b of analysis.bridges) {
    const ek = `${b.source}|||${b.target}`;
    if (hasHighlights && highlightedEdges.has(ek)) continue;

    const sp = positions.get(b.source);
    const tp = positions.get(b.target);
    if (!sp || !tp) continue;

    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(tp.x, tp.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 3. Highlighted edges — pre-parse edge keys once instead of split() per frame
  if (hasHighlights) {
    const parsedHighlightEdges: { source: string; target: string }[] = [];
    for (const ek of highlightedEdges) {
      const sep = ek.indexOf('|||');
      if (sep !== -1) parsedHighlightEdges.push({ source: ek.slice(0, sep), target: ek.slice(sep + 3) });
    }

    ctx.strokeStyle = COLORS.edgeHighlight;
    ctx.lineWidth = 2 / zoom;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (const { source, target } of parsedHighlightEdges) {
      const sp = positions.get(source);
      const tp = positions.get(target);
      if (!sp || !tp) continue;
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(tp.x, tp.y);
    }
    ctx.stroke();

    ctx.fillStyle = COLORS.edgeHighlight;
    ctx.globalAlpha = 1;
    for (const { source, target } of parsedHighlightEdges) {
      const sp = positions.get(source);
      const tp = positions.get(target);
      if (!sp || !tp) continue;
      drawArrow(ctx, sp.x, sp.y, tp.x, tp.y, 6 / zoom);
    }
  }

  // --- Draw nodes ---
  ctx.globalAlpha = 1;

  // Compute max phase for coloring
  const maxPhase = analysis.buildPhases.length > 0
    ? analysis.buildPhases[analysis.buildPhases.length - 1].phase
    : 0;
  const usePhaseColors = layoutType === 'phases';

  function getNodeColor(id: string, metrics: ReturnType<typeof analysis.nodeMetrics.get>): string {
    if (!metrics) return COLORS.normal;
    if (usePhaseColors) return phaseColor(metrics.buildPhase, maxPhase);
    return nodeColor(id, metrics);
  }

  // Batch dimmed nodes
  if (hasHighlights) {
    ctx.globalAlpha = 0.08;
    for (const node of graph.nodes) {
      if (highlightedNodes.has(node.id) || node.id === selectedNode || node.id === hoveredNode) continue;
      const pos = positions.get(node.id);
      const metrics = analysis.nodeMetrics.get(node.id);
      if (!pos || !metrics) continue;

      const r = nodeRadius(metrics.inDegree, nodeCount);
      ctx.fillStyle = getNodeColor(node.id, metrics);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Non-dimmed nodes
  ctx.globalAlpha = 1;
  for (const node of graph.nodes) {
    if (hasHighlights && !highlightedNodes.has(node.id) && node.id !== selectedNode && node.id !== hoveredNode) continue;

    const pos = positions.get(node.id);
    const metrics = analysis.nodeMetrics.get(node.id);
    if (!pos || !metrics) continue;

    const isSelected = node.id === selectedNode;
    const isHovered = node.id === hoveredNode;
    const isHighlighted = highlightedNodes.has(node.id);

    const r = nodeRadius(metrics.inDegree, nodeCount);
    const displayR = (isSelected || isHovered) ? r * 1.4 : isHighlighted ? r * 1.2 : r;

    // Glow for selected/hovered
    if (isSelected || isHovered) {
      ctx.fillStyle = isSelected ? COLORS.selected : COLORS.highlighted;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, displayR * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = isSelected ? COLORS.selected : isHighlighted ? COLORS.highlighted : getNodeColor(node.id, metrics);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, displayR, 0, Math.PI * 2);
    ctx.fill();

    // Border
    if (isSelected) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2 / zoom;
      ctx.stroke();
    }
  }

  // --- Labels ---
  const showAllLabels = showLabels && zoom > (nodeCount > 500 ? 1.5 : 0.5);
  const showImportantLabels = zoom > 0.3;

  if (showAllLabels || showImportantLabels || hoveredNode || selectedNode) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const node of graph.nodes) {
      const pos = positions.get(node.id);
      const metrics = analysis.nodeMetrics.get(node.id);
      if (!pos || !metrics) continue;

      const isSelected = node.id === selectedNode;
      const isHovered = node.id === hoveredNode;
      const isHighlighted = highlightedNodes.has(node.id);

      let shouldLabel = false;
      if (isSelected || isHovered) shouldLabel = true;
      else if (isHighlighted) shouldLabel = true;
      else if (showAllLabels && !(hasHighlights)) shouldLabel = true;
      else if (showImportantLabels && !hasHighlights && (metrics.isRoot || metrics.inDegree >= 5)) shouldLabel = true;

      if (!shouldLabel) continue;

      const r = nodeRadius(metrics.inDegree, nodeCount);
      const fontSize = Math.max(8, Math.min(12, 10 / zoom));
      ctx.font = `${fontSize / zoom}px monospace`;
      ctx.fillStyle = (hasHighlights && !isHighlighted && !isSelected && !isHovered)
        ? COLORS.textDim : COLORS.text;
      ctx.globalAlpha = (hasHighlights && !isHighlighted && !isSelected && !isHovered) ? 0.15 : 1;

      const label = shortLabel(node.id);
      ctx.fillText(label, pos.x, pos.y + r + 3 / zoom, 200 / zoom);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function shortLabel(id: string): string {
  let s = id.replace(/^\/\//, '').replace(/^@[^/]+\/\//, '@');
  if (s.length > 40) {
    const parts = s.split('/');
    s = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : s;
  }
  return s;
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const ux = dx / len, uy = dy / len;
  // Arrow at 70% along the edge
  const mx = x1 + dx * 0.7, my = y1 + dy * 0.7;
  ctx.beginPath();
  ctx.moveTo(mx + ux * size, my + uy * size);
  ctx.lineTo(mx - ux * size * 0.5 + uy * size * 0.5, my - uy * size * 0.5 - ux * size * 0.5);
  ctx.lineTo(mx - ux * size * 0.5 - uy * size * 0.5, my - uy * size * 0.5 + ux * size * 0.5);
  ctx.closePath();
  ctx.fill();
}

/**
 * Build a quadtree for node hit testing.
 */
export function buildHitTree(
  positions: Map<string, NodePosition>,
  nodeCount: number,
  analysis: AnalysisResult
): QuadTree {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pos of positions.values()) {
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
  }

  const pad = 200;
  const qt = new QuadTree({
    x: minX - pad, y: minY - pad,
    w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad,
  });

  for (const [id, pos] of positions) {
    qt.insert({ x: pos.x, y: pos.y, id, mass: 1 });
  }

  return qt;
}

/**
 * Screen coords to world coords.
 */
export function screenToWorld(sx: number, sy: number, view: ViewState): { x: number; y: number } {
  return {
    x: (sx - view.offsetX) / view.zoom,
    y: (sy - view.offsetY) / view.zoom,
  };
}
