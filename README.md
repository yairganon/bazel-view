# Bazel View

Interactive dependency graph analyzer for Bazel. Paste the output of `bazel query --output=graph` and get instant visibility into your build structure — what's slow, what's redundant, and what to cut.

## The Problem

Bazel builds at scale are opaque. You have thousands of targets, complex dependency chains, and no easy way to answer:

- **"Why is my build slow?"** — Which phase is the bottleneck? Where does parallelism collapse to a single target?
- **"Can I safely remove this dep?"** — Will it come back through another path? How many independent routes pull it in?
- **"What's the biggest win?"** — If I could remove one node from the graph, which one saves the most?
- **"How did this dep get here?"** — What's the shortest path from my target to that random third-party lib?

Existing tools give you a static DOT image that's unreadable at scale, or raw CLI output you have to script against. Bazel View gives you the analysis directly.

## What You Get

### Build Phase Timeline

Bazel builds bottom-up in waves. Phase 0 (leaves) builds first in parallel, then phase 1, and so on. Bazel View computes these phases and shows you:

- A **waterfall timeline** — each phase as a horizontal bar showing parallelism
- **Bottleneck detection** — phases with few targets blocking many are flagged with their blocking ratio
- **Click any phase** to see its targets and highlight them on the graph

Cycles at the package level (which are normal in Bazel) are handled via SCC condensation — no incorrect results.

### Impact Analysis

Click "Compute Impact Rankings" and Bazel View tests **every node** in your graph: what happens if it's removed? Results are ranked by impact:

- **-N nodes (X% of build)** — how much the build shrinks
- **Before/After comparison** — visual bar showing the reduction
- **Orphaned nodes list** — exactly which targets drop out

This tells you where to focus optimization effort. The #1 result is the single highest-leverage dep to eliminate.

### Path Finding

Select two nodes and find all paths between them:

- **K-shortest paths** via Yen's algorithm — finds diverse routes efficiently, no brute-force explosion
- **Independent route count** — how many node-disjoint paths exist (how many you need to cut to fully break the dependency)
- **Visual pipeline** — step through each path node by node with metadata

### Node Inspector

Click any node to see:

- Build phase, in/out degree, transitive dep count
- Tags: root, leaf, bridge, sole link
- **Show deps / rdeps** — highlight the full dependency tree in either direction
- **"What if removed?"** — instant simulation showing cost savings, orphaned nodes, broken edges

### Smart Search

Multi-word fuzzy autocomplete across all nodes:

- `a g c loom` matches `api-gateway-client/.../loom` (segment prefix matching)
- Results ranked by match quality + node importance
- Each result shows phase, degree, and transitive dep count

### Graph Visualization

Custom Canvas2D renderer — no Cytoscape, no D3, no external graph libraries:

- **Force-directed layout** with Barnes-Hut quadtree (O(n log n))
- **Phase layout** — nodes arranged in horizontal rows by build phase with labeled lanes
- **Hierarchical and radial layouts**
- Pan, zoom, hover labels, click to select
- Handles 5,000+ nodes and 20,000+ edges without freezing

## How It Works Under the Hood

| Feature | Algorithm | Complexity |
|---------|-----------|------------|
| Build phases | SCC condensation (Tarjan) + topological sort | O(V+E) |
| Transitive dep count | Bitset reachability on condensed DAG | O(V²/32) |
| Path finding | Yen's K-shortest paths | O(K·V·(V+E)) |
| Independent routes | Iterative BFS with node removal | O(K·(V+E)) |
| Impact ranking | BFS per candidate node | O(V·(V+E)) |
| Bottleneck detection | Phase parallelism + blocking ratio | O(V) |
| Force layout | Barnes-Hut N-body simulation | O(N log N) per tick |
| Hover/click detection | Quadtree spatial index | O(log N) |

All BFS queues use index pointers (not `Array.shift()`) for true O(1) dequeue. The entire analysis runs in the browser — no backend needed.

## Getting Started

### Generate the dependency graph

```bash
bazel query 'deps(//your/target)' --output=graph > deps.dot
```

### Run Bazel View

```bash
git clone https://github.com/yairganon/bazel-view.git
cd bazel-view
npm install
npm run dev
```

Open `http://localhost:5173`, upload or paste your DOT file, and explore.

### Filter Options

On import, you can edit the exclude patterns to filter out build infrastructure noise (toolchains, rules_scala internals, source files, etc.). The defaults strip common Bazel noise but you can customize them for your repo.

## Tech Stack

- **React + TypeScript** — UI
- **Canvas2D** — graph rendering (custom, no libraries)
- **Tailwind CSS** — styling
- **Vite** — dev server and build
- **Zero graph dependencies** — all layout, analysis, and rendering is custom code

## Contributing

Issues and PRs welcome. The codebase is ~4,000 lines across 14 source files with no external graph dependencies, so it's easy to hack on.

## License

MIT
