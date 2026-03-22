/**
 * Layout algorithms for graph positioning.
 * All run off the main thread via chunked computation.
 */

import { QuadTree } from './quadtree';
import type { ParsedGraph, AnalysisResult } from '../graph';

export interface NodePosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type LayoutType = 'force' | 'phases' | 'hierarchical' | 'radial';

/**
 * Initialize positions. Hierarchical uses depth for Y, hash for X.
 */
export function initPositions(
  graph: ParsedGraph,
  analysis: AnalysisResult,
  type: LayoutType,
  width: number,
  height: number
): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();

  if (type === 'phases') {
    // Build phases: phase 0 (leaves) at bottom, root at top.
    // Each phase is a horizontal row. Nodes spread within the row.
    const phaseGroups = new Map<number, string[]>();
    let maxPhase = 0;
    for (const node of graph.nodes) {
      const m = analysis.nodeMetrics.get(node.id);
      const phase = m?.buildPhase ?? 0;
      maxPhase = Math.max(maxPhase, phase);
      const group = phaseGroups.get(phase) ?? [];
      group.push(node.id);
      phaseGroups.set(phase, group);
    }

    const rowHeight = height / (maxPhase + 2);
    for (const [phase, nodes] of phaseGroups) {
      const xSpacing = width / (nodes.length + 1);
      // Phase 0 at bottom, highest phase at top
      const y = height - rowHeight * (phase + 1);
      nodes.forEach((id, i) => {
        positions.set(id, {
          x: xSpacing * (i + 1),
          y,
          vx: 0, vy: 0,
        });
      });
    }
  } else if (type === 'hierarchical') {
    // Group nodes by depth
    const depthGroups = new Map<number, string[]>();
    let maxDepth = 0;
    for (const node of graph.nodes) {
      const m = analysis.nodeMetrics.get(node.id);
      const depth = m?.depth ?? 0;
      maxDepth = Math.max(maxDepth, depth);
      const group = depthGroups.get(depth) ?? [];
      group.push(node.id);
      depthGroups.set(depth, group);
    }

    const ySpacing = height / (maxDepth + 2);
    for (const [depth, nodes] of depthGroups) {
      const xSpacing = width / (nodes.length + 1);
      nodes.forEach((id, i) => {
        positions.set(id, {
          x: xSpacing * (i + 1),
          y: ySpacing * (depth + 1),
          vx: 0, vy: 0,
        });
      });
    }
  } else if (type === 'radial') {
    // Roots at center, deeper nodes in concentric rings
    const cx = width / 2, cy = height / 2;
    const depthGroups = new Map<number, string[]>();
    let maxDepth = 0;
    for (const node of graph.nodes) {
      const m = analysis.nodeMetrics.get(node.id);
      const depth = m?.depth ?? 0;
      maxDepth = Math.max(maxDepth, depth);
      const group = depthGroups.get(depth) ?? [];
      group.push(node.id);
      depthGroups.set(depth, group);
    }

    const ringSpacing = Math.min(width, height) / (2 * (maxDepth + 2));
    for (const [depth, nodes] of depthGroups) {
      const r = ringSpacing * (depth + 1);
      const angleStep = (2 * Math.PI) / Math.max(nodes.length, 1);
      nodes.forEach((id, i) => {
        positions.set(id, {
          x: cx + r * Math.cos(angleStep * i),
          y: cy + r * Math.sin(angleStep * i),
          vx: 0, vy: 0,
        });
      });
    }
  } else {
    // Force layout: random initial positions, seeded by hash
    for (const node of graph.nodes) {
      const hash = simpleHash(node.id);
      positions.set(node.id, {
        x: width * 0.1 + (hash % 1000) / 1000 * width * 0.8,
        y: height * 0.1 + ((hash >> 10) % 1000) / 1000 * height * 0.8,
        vx: 0, vy: 0,
      });
    }
  }

  return positions;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Run one tick of force-directed layout.
 * Uses Barnes-Hut quadtree for O(n log n) repulsion.
 */
export function forceLayoutTick(
  graph: ParsedGraph,
  positions: Map<string, NodePosition>,
  tick: number
): boolean {
  const alpha = Math.max(0.001, 0.3 * Math.pow(0.99, tick));
  if (alpha < 0.002) return true; // settled

  // Find bounds for quadtree
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pos of positions.values()) {
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
  }
  const pad = 100;
  const qt = new QuadTree({
    x: minX - pad, y: minY - pad,
    w: maxX - minX + 2 * pad,
    h: maxY - minY + 2 * pad,
  });

  // Insert all nodes into quadtree
  const points = new Map<string, { x: number; y: number; mass: number }>();
  for (const [id, pos] of positions) {
    const p = { x: pos.x, y: pos.y, mass: 1, id };
    points.set(id, p);
    qt.insert(p);
  }

  // Repulsive forces (Barnes-Hut)
  const repulsion = 800;
  const forces = new Map<string, { fx: number; fy: number }>();
  for (const [id, p] of points) {
    const f = qt.computeForce(p, 0.7);
    forces.set(id, { fx: f.fx * repulsion, fy: f.fy * repulsion });
  }

  // Attractive forces (edges)
  const attraction = 0.03;
  const idealLength = 120;
  for (const edge of graph.edges) {
    const sp = positions.get(edge.source);
    const tp = positions.get(edge.target);
    if (!sp || !tp) continue;

    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = attraction * (d - idealLength);
    const fx = dx / d * force;
    const fy = dy / d * force;

    const sf = forces.get(edge.source)!;
    const tf = forces.get(edge.target)!;
    sf.fx += fx;
    sf.fy += fy;
    tf.fx -= fx;
    tf.fy -= fy;
  }

  // Gravity toward center
  let cx = 0, cy = 0, n = 0;
  for (const pos of positions.values()) {
    cx += pos.x; cy += pos.y; n++;
  }
  cx /= n; cy /= n;
  const gravity = 0.02;

  // Apply forces
  const damping = 0.6;
  let maxMove = 0;

  for (const [id, pos] of positions) {
    const f = forces.get(id)!;
    f.fx += (cx - pos.x) * gravity;
    f.fy += (cy - pos.y) * gravity;

    pos.vx = (pos.vx + f.fx * alpha) * damping;
    pos.vy = (pos.vy + f.fy * alpha) * damping;

    // Cap velocity
    const speed = Math.sqrt(pos.vx * pos.vx + pos.vy * pos.vy);
    const maxSpeed = 50;
    if (speed > maxSpeed) {
      pos.vx = pos.vx / speed * maxSpeed;
      pos.vy = pos.vy / speed * maxSpeed;
    }

    pos.x += pos.vx;
    pos.y += pos.vy;
    maxMove = Math.max(maxMove, Math.abs(pos.vx) + Math.abs(pos.vy));
  }

  return maxMove < 0.5; // settled
}
