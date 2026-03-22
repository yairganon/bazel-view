/**
 * Quadtree for spatial indexing — used for:
 * 1. Barnes-Hut force approximation (O(n log n) instead of O(n^2))
 * 2. Fast hover/click detection
 */

export interface Point {
  x: number;
  y: number;
  id?: string;
  mass?: number;
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class QuadTree {
  bounds: Bounds;
  points: Point[] = [];
  nw: QuadTree | null = null;
  ne: QuadTree | null = null;
  sw: QuadTree | null = null;
  se: QuadTree | null = null;
  // Center of mass for Barnes-Hut
  cx = 0;
  cy = 0;
  totalMass = 0;
  divided = false;

  constructor(bounds: Bounds, private capacity = 4) {
    this.bounds = bounds;
  }

  insert(p: Point): boolean {
    if (!this.contains(p)) return false;

    // Update center of mass
    const mass = p.mass ?? 1;
    this.cx = (this.cx * this.totalMass + p.x * mass) / (this.totalMass + mass);
    this.cy = (this.cy * this.totalMass + p.y * mass) / (this.totalMass + mass);
    this.totalMass += mass;

    if (this.points.length < this.capacity && !this.divided) {
      this.points.push(p);
      return true;
    }

    if (!this.divided) this.subdivide();

    return (
      this.nw!.insert(p) ||
      this.ne!.insert(p) ||
      this.sw!.insert(p) ||
      this.se!.insert(p)
    );
  }

  private subdivide() {
    const { x, y, w, h } = this.bounds;
    const hw = w / 2, hh = h / 2;
    this.nw = new QuadTree({ x, y, w: hw, h: hh }, this.capacity);
    this.ne = new QuadTree({ x: x + hw, y, w: hw, h: hh }, this.capacity);
    this.sw = new QuadTree({ x, y: y + hh, w: hw, h: hh }, this.capacity);
    this.se = new QuadTree({ x: x + hw, y: y + hh, w: hw, h: hh }, this.capacity);
    this.divided = true;

    // Re-insert existing points
    for (const p of this.points) {
      this.nw.insert(p) || this.ne.insert(p) || this.sw.insert(p) || this.se.insert(p);
    }
    this.points = [];
  }

  private contains(p: Point): boolean {
    const { x, y, w, h } = this.bounds;
    return p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;
  }

  /**
   * Find nearest point within radius.
   */
  queryNearest(px: number, py: number, radius: number): Point | null {
    let best: Point | null = null;
    let bestDist = radius * radius;

    this._queryNearest(px, py, bestDist, (p, d2) => {
      if (d2 < bestDist) {
        bestDist = d2;
        best = p;
      }
    });

    return best;
  }

  private _queryNearest(px: number, py: number, radiusSq: number, cb: (p: Point, d2: number) => void) {
    const { x, y, w, h } = this.bounds;

    // Check if this quad could contain a closer point
    const closestX = Math.max(x, Math.min(px, x + w));
    const closestY = Math.max(y, Math.min(py, y + h));
    const dx = px - closestX, dy = py - closestY;
    if (dx * dx + dy * dy > radiusSq) return;

    for (const p of this.points) {
      const d2 = (px - p.x) ** 2 + (py - p.y) ** 2;
      cb(p, d2);
    }

    if (this.divided) {
      this.nw!._queryNearest(px, py, radiusSq, cb);
      this.ne!._queryNearest(px, py, radiusSq, cb);
      this.sw!._queryNearest(px, py, radiusSq, cb);
      this.se!._queryNearest(px, py, radiusSq, cb);
    }
  }

  /**
   * Barnes-Hut force calculation: compute repulsive force from this quad on point p.
   * theta = accuracy parameter (0.5-1.0, lower = more accurate but slower)
   */
  computeForce(p: Point, theta: number): { fx: number; fy: number } {
    if (this.totalMass === 0) return { fx: 0, fy: 0 };

    const dx = this.cx - p.x;
    const dy = this.cy - p.y;
    const d2 = dx * dx + dy * dy + 1; // +1 to avoid division by zero
    const d = Math.sqrt(d2);

    // If this quad is far enough away, treat as single body
    const { w } = this.bounds;
    if (w / d < theta || (!this.divided && this.points.length <= 1)) {
      const force = -this.totalMass / d2;
      return { fx: dx * force / d, fy: dy * force / d };
    }

    // Otherwise recurse into children
    let fx = 0, fy = 0;

    for (const pt of this.points) {
      if (pt === p) continue;
      const pdx = pt.x - p.x;
      const pdy = pt.y - p.y;
      const pd2 = pdx * pdx + pdy * pdy + 1;
      const pd = Math.sqrt(pd2);
      const force = -(pt.mass ?? 1) / pd2;
      fx += pdx * force / pd;
      fy += pdy * force / pd;
    }

    if (this.divided) {
      const f1 = this.nw!.computeForce(p, theta);
      const f2 = this.ne!.computeForce(p, theta);
      const f3 = this.sw!.computeForce(p, theta);
      const f4 = this.se!.computeForce(p, theta);
      fx += f1.fx + f2.fx + f3.fx + f4.fx;
      fy += f1.fy + f2.fy + f3.fy + f4.fy;
    }

    return { fx, fy };
  }
}
