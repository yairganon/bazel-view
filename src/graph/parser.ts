/**
 * Parse Bazel query DOT output into a graph structure.
 * Input: `bazel query 'deps(//target)' --output=graph`
 *
 * Handles large graphs (40K+ lines) with:
 * - \n inside node IDs (Bazel multi-target nodes)
 * - Build infrastructure noise filtering
 */

export interface GraphNode {
  id: string;
  label: string;
  package: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FilterOptions {
  excludePatterns: string[];
  includeOnlyPatterns: string[];  // if non-empty, only include matching
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '@bazel_tools//',
  '@io_bazel_rules_scala//',
  '@core_server_build_tools//',
  '@remotejdk',
  '@remote_java_tools',
  'tools/jdk:',
  'tools/test:',
  '.sh',
  '.srcjar',
  '_deploy.jar',
  '_java_runtime',
  '_host_java_runtime',
  ':scalac',
  ':exe',
  'coverage/instrumenter',
  'dependency_analyzer',
  'phase_',
  'dep_trackers',
];

function extractPackage(label: string): string {
  // //foo/bar:baz -> //foo/bar
  // @repo//foo:bar -> @repo//foo
  const match = label.match(/^(@[^/]+\/\/[^:]*|\/\/[^:]*)/);
  return match ? match[1] : label;
}

export function parseDot(dot: string, filter?: FilterOptions): ParsedGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const excludes = filter?.excludePatterns ?? [];
  const includes = filter?.includeOnlyPatterns ?? [];

  // Normalize \n inside quoted strings (Bazel emits multi-target nodes)
  const normalized = dot.replace(/"([^"]*?)\\n([^"]*?)"/g, (_, a, b) => {
    // Take just the first target from a multi-target node
    return `"${a}"`;
  });

  const lines = normalized.split('\n');

  // Source file extensions — match on the target name (after :), not the path
  const sourceExts = ['.java', '.scala', '.py', '.go', '.rs'];

  function shouldExclude(id: string): boolean {
    // Check source file targets: "//path:Foo.java" should be excluded
    // but "//path/src/main/java/com/foo:lib" should NOT
    const colonIdx = id.lastIndexOf(':');
    if (colonIdx !== -1) {
      const targetName = id.slice(colonIdx + 1);
      for (const ext of sourceExts) {
        if (targetName.endsWith(ext)) return true;
      }
    }

    for (const pat of excludes) {
      if (id.includes(pat)) return true;
    }
    if (includes.length > 0) {
      return !includes.some(pat => id.includes(pat));
    }
    return false;
  }

  function ensureNode(rawId: string) {
    const id = rawId;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: id,
        package: extractPackage(rawId),
      });
    }
    return id;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Match edge: "A" -> "B"
    const edgeMatch = trimmed.match(/"([^"]+)"\s*->\s*"([^"]+)"/);
    if (edgeMatch) {
      const rawSource = edgeMatch[1];
      const rawTarget = edgeMatch[2];

      if (shouldExclude(rawSource) || shouldExclude(rawTarget)) continue;

      const source = ensureNode(rawSource);
      const target = ensureNode(rawTarget);

      edges.push({ source, target });
      continue;
    }

    // Match standalone node: "A"
    const nodeMatch = trimmed.match(/^"([^"]+)"\s*[\[;]?$/);
    if (nodeMatch && !trimmed.includes('->') && !trimmed.startsWith('digraph') && !trimmed.startsWith('}')) {
      const rawId = nodeMatch[1];
      if (!shouldExclude(rawId)) {
        ensureNode(rawId);
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
  };
}

/**
 * Parse simple text format: one "source -> target" per line.
 */
export function parseTextFormat(text: string, filter?: FilterOptions): ParsedGraph {
  // Convert to pseudo-DOT and reuse parseDot
  const lines = text.split('\n').map(l => {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('#')) return '';
    const arrowMatch = trimmed.match(/^([^\s]+)\s*->\s*([^\s]+)/);
    if (arrowMatch) {
      return `"${arrowMatch[1]}" -> "${arrowMatch[2]}"`;
    }
    return '';
  }).filter(Boolean);

  return parseDot(lines.join('\n'), filter);
}

export function autoParseGraph(input: string, filter?: FilterOptions): ParsedGraph {
  const trimmed = input.trim();
  if (trimmed.startsWith('digraph') || trimmed.includes('" -> "')) {
    return parseDot(trimmed, filter);
  }
  return parseTextFormat(trimmed, filter);
}
