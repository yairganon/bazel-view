import { useState, useRef, useEffect, useMemo } from 'react';
import type { AnalysisResult } from '../graph';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  analysis?: AnalysisResult;
  placeholder?: string;
  label?: string;
}

function shortLabel(id: string): string {
  return id.replace(/^\/\//, '').replace(/^@[^/]+\/\//, '@');
}

interface ScoredOption {
  id: string;
  score: number;
  matchRanges: [number, number][]; // for highlight
}

/**
 * Multi-word fuzzy scoring.
 * "sdl ninja" matches "iptf/simple-data-layer/.../ninja/..."
 * Each query word must appear somewhere. Score rewards:
 *   - Match in last path segment (most specific)
 *   - Consecutive matches
 *   - Node importance (in-degree, transitive deps)
 */
/**
 * Try to match query words against path segments as prefix/initials.
 * "a g c" matches "api-gateway-client" because each word is a prefix
 * of a hyphen-separated or slash-separated part.
 *
 * Returns match ranges and a score, or null if no match.
 */
function scoreMatch(id: string, queryWords: string[], analysis?: AnalysisResult): ScoredOption | null {
  const label = shortLabel(id).toLowerCase();
  const matchRanges: [number, number][] = [];

  // Split label into segments: both "/" and "-" are separators
  // "framework/loom/api-gateway-client" → ["framework", "loom", "api", "gateway", "client"]
  const parts: { text: string; start: number }[] = [];
  let pos = 0;
  for (const seg of label.split(/([/\-_:.@])/)) {
    if (seg && !seg.match(/^[/\-_:.@]$/)) {
      parts.push({ text: seg, start: pos });
    }
    pos += seg.length;
  }

  // Try to match each query word in order against remaining parts.
  // A word matches a part if:
  //   1. Part starts with the word (prefix match: "a" matches "api")
  //   2. Word is a substring of the part (contains match: "gate" matches "gateway")
  let partIdx = 0;
  let score = 0;
  let allPrefixMatch = true;

  for (const word of queryWords) {
    let matched = false;

    // First pass: try prefix match on remaining parts (in order)
    for (let i = partIdx; i < parts.length; i++) {
      const part = parts[i];
      if (part.text.startsWith(word)) {
        matchRanges.push([part.start, part.start + word.length]);
        // Consecutive matches score higher
        score += (i === partIdx) ? 40 : 20;
        // Single-char prefix match on segment start (initials mode)
        if (word.length === 1) score += 15;
        // Longer prefix matches score higher
        score += Math.min(15, word.length * 3);
        partIdx = i + 1;
        matched = true;
        break;
      }
    }

    // Second pass: try substring match anywhere (weaker)
    if (!matched) {
      allPrefixMatch = false;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const idx = part.text.indexOf(word);
        if (idx !== -1) {
          matchRanges.push([part.start + idx, part.start + idx + word.length]);
          score += 5 + Math.min(10, word.length * 2);
          matched = true;
          break;
        }
      }
    }

    // Third pass: try substring match on full label
    if (!matched) {
      allPrefixMatch = false;
      const idx = label.indexOf(word);
      if (idx !== -1) {
        matchRanges.push([idx, idx + word.length]);
        score += 2;
        matched = true;
      }
    }

    if (!matched) return null;
  }

  // Bonus: all words matched as segment prefixes in order (best case)
  if (allPrefixMatch) score += 30;

  // Bonus: fewer total segments = more specific path
  score += Math.max(0, 15 - parts.length);

  // Bonus: last segment match (most specific part of the path)
  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    for (const word of queryWords) {
      if (lastPart.text.startsWith(word)) score += 25;
      else if (lastPart.text.includes(word)) score += 10;
    }
  }

  // Node importance bonus
  if (analysis) {
    const m = analysis.nodeMetrics.get(id);
    if (m) {
      score += Math.min(10, m.inDegree * 0.5);
      score += Math.min(5, m.transitiveDepCount * 0.01);
      if (m.isRoot) score += 8;
    }
  }

  return { id, score, matchRanges };
}

function HighlightedLabel({ label, ranges, focused }: { label: string; ranges: [number, number][]; focused: boolean }) {
  if (ranges.length === 0) return <span>{label}</span>;

  // Merge overlapping ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }

  const parts: JSX.Element[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (pos < start) {
      parts.push(<span key={`t-${pos}`}>{label.slice(pos, start)}</span>);
    }
    parts.push(
      <span key={`h-${start}`} className={focused ? 'text-white font-semibold' : 'text-yellow-400 font-semibold'}>
        {label.slice(start, end)}
      </span>
    );
    pos = end;
  }
  if (pos < label.length) {
    parts.push(<span key={`t-${pos}`}>{label.slice(pos)}</span>);
  }

  return <>{parts}</>;
}

export default function Autocomplete({ value, onChange, options, analysis, placeholder, label }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const displayValue = open ? query : (value ? shortLabel(value) : '');

  const filtered = useMemo(() => {
    if (!query.trim()) {
      // No query: show roots first, then by transitive dep count
      if (analysis) {
        return [...options]
          .sort((a, b) => {
            const ma = analysis.nodeMetrics.get(a);
            const mb = analysis.nodeMetrics.get(b);
            const ra = ma?.isRoot ? 1 : 0;
            const rb = mb?.isRoot ? 1 : 0;
            if (ra !== rb) return rb - ra;
            return (mb?.transitiveDepCount ?? 0) - (ma?.transitiveDepCount ?? 0);
          })
          .slice(0, 30)
          .map(id => ({ id, score: 0, matchRanges: [] as [number, number][] }));
      }
      return options.slice(0, 30).map(id => ({ id, score: 0, matchRanges: [] as [number, number][] }));
    }

    // Split query into words for multi-word matching
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);

    const results: ScoredOption[] = [];
    for (const opt of options) {
      const scored = scoreMatch(opt, words, analysis);
      if (scored) results.push(scored);
      if (results.length >= 200) break; // scan cap
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 30);
  }, [query, options, analysis]);

  useEffect(() => { setFocusIndex(0); }, [filtered]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[focusIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, open]);

  const handleSelect = (id: string) => {
    onChange(id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex(i => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[focusIndex]) handleSelect(filtered[focusIndex].id);
        break;
      case 'Escape':
        setOpen(false);
        setQuery('');
        break;
    }
  };

  return (
    <div className="relative">
      {label && <label className="text-xs text-gray-400">{label}</label>}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={e => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setQuery(value ? shortLabel(value) : '');
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Type to search...'}
          className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-500 pr-6 focus:border-blue-600 focus:outline-none"
        />
        {value && (
          <button
            onClick={() => { onChange(''); setQuery(''); }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs px-1"
          >
            ×
          </button>
        )}
      </div>

      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-50 w-full mt-0.5 bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-h-64 overflow-y-auto"
        >
          {filtered.map((opt, i) => {
            const metrics = analysis?.nodeMetrics.get(opt.id);
            const isFocused = i === focusIndex;
            const sl = shortLabel(opt.id);

            return (
              <button
                key={opt.id}
                onMouseDown={e => { e.preventDefault(); handleSelect(opt.id); }}
                className={`w-full text-left px-2.5 py-1.5 flex items-center gap-2 ${
                  isFocused
                    ? 'bg-blue-600'
                    : 'hover:bg-gray-800'
                }`}
              >
                {/* Type indicator dot */}
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  metrics?.isRoot ? 'bg-cyan-400' :
                  metrics?.isLeaf ? 'bg-purple-400' :
                  opt.id.startsWith('@') ? 'bg-pink-400' :
                  'bg-gray-500'
                }`} />

                {/* Label + metadata */}
                <div className="flex-1 min-w-0">
                  <div className={`text-xs truncate ${isFocused ? 'text-white' : 'text-gray-300'}`}>
                    <HighlightedLabel label={sl} ranges={opt.matchRanges} focused={isFocused} />
                  </div>
                  {metrics && (
                    <div className={`text-[10px] ${isFocused ? 'text-blue-200' : 'text-gray-600'}`}>
                      phase {metrics.buildPhase}
                      {metrics.inDegree > 0 && ` · ${metrics.inDegree} in`}
                      {metrics.transitiveDepCount > 0 && ` · ${metrics.transitiveDepCount} deps`}
                    </div>
                  )}
                </div>

                {/* Tags */}
                {metrics?.isRoot && (
                  <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${
                    isFocused ? 'bg-blue-500 text-blue-100' : 'bg-cyan-900 text-cyan-400'
                  }`}>root</span>
                )}
              </button>
            );
          })}
          {filtered.length >= 30 && (
            <div className="px-2.5 py-1.5 text-[10px] text-gray-600 border-t border-gray-800">
              Type more to narrow · try multiple words like "sdl ninja"
            </div>
          )}
        </div>
      )}
    </div>
  );
}
