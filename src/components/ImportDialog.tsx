import { useState, useRef } from 'react';
import { SAMPLE_DOT, DEFAULT_EXCLUDE_PATTERNS } from '../graph';
import type { FilterOptions } from '../graph';

interface Props {
  onImport: (data: string, filter: FilterOptions) => void;
  loading: boolean;
  error: string | null;
}

export default function ImportDialog({ onImport, loading, error }: Props) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [filterNoise, setFilterNoise] = useState(true);
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDE_PATTERNS.join('\n'));
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setText(reader.result as string);
    };
    reader.readAsText(file);
  };

  const buildFilter = (): FilterOptions => {
    const excludePatterns = filterNoise
      ? excludeText.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    return {
      excludePatterns,
      includeOnlyPatterns: [],
    };
  };

  const handleLoad = () => {
    if (!text.trim()) return;
    onImport(text, buildFilter());
  };

  const handleLoadSample = () => {
    onImport(SAMPLE_DOT, { excludePatterns: [], includeOnlyPatterns: [] });
  };

  const lineCount = text ? text.split('\n').length : 0;

  return (
    <div className="flex items-center justify-center h-screen bg-gray-950">
      <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 space-y-4">
        <h1 className="text-xl font-bold text-white">Bazel View</h1>
        <p className="text-sm text-gray-400">
          Paste <code className="bg-gray-700 px-1 rounded">bazel query 'deps(//target)' --output=graph</code> output,
          or upload a DOT file.
        </p>

        {/* File input */}
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <button
              onClick={() => fileRef.current?.click()}
              className="px-4 py-2 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-sm"
            >
              Choose File
            </button>
            <input ref={fileRef} type="file" accept=".dot,.txt,.gv" onChange={handleFile} className="hidden" />
            {fileName && (
              <span className="text-sm text-gray-400">
                {fileName} ({lineCount.toLocaleString()} lines)
              </span>
            )}
          </div>

          <textarea
            value={text}
            onChange={e => { setText(e.target.value); setFileName(null); }}
            placeholder={`digraph mygraph {\n  "//app:main" -> "//lib:core"\n  ...\n}`}
            className="w-full h-40 bg-gray-900 border border-gray-700 rounded p-3 text-xs font-mono text-green-400 placeholder-gray-600 resize-none"
          />
        </div>

        {/* Filter options */}
        <div className="bg-gray-900 rounded p-3 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">Import Options</h3>

          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={filterNoise}
              onChange={e => setFilterNoise(e.target.checked)}
              className="rounded"
            />
            Filter build infrastructure
            <span className="text-xs text-gray-500">(bazel_tools, rules_scala, toolchains, source files)</span>
          </label>

          {filterNoise && (
            <div>
              <label className="text-xs text-gray-400">Exclude patterns (one per line — edit to add/remove):</label>
              <textarea
                value={excludeText}
                onChange={e => setExcludeText(e.target.value)}
                className="w-full h-40 bg-gray-950 border border-gray-700 rounded p-2 text-xs font-mono text-gray-300 placeholder-gray-600 resize-y mt-1"
              />
              <button
                onClick={() => setExcludeText(DEFAULT_EXCLUDE_PATTERNS.join('\n'))}
                className="text-[10px] text-gray-500 hover:text-gray-300 mt-1"
              >
                Reset to defaults
              </button>
            </div>
          )}

          {!filterNoise && (
            <div className="text-xs text-gray-500">
              No filtering — all nodes from the DOT file will be included.
            </div>
          )}

        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleLoad}
            disabled={!text.trim() || loading}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {loading ? 'Loading...' : 'Load Graph'}
          </button>

          <button
            onClick={handleLoadSample}
            disabled={loading}
            className="px-4 py-2 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-sm disabled:opacity-50"
          >
            Load Sample
          </button>
        </div>

        {error && (
          <div className="bg-red-900/50 text-red-300 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <div className="text-xs text-gray-500 space-y-1">
          <p>Supported formats:</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>DOT format from <code className="bg-gray-700 px-0.5 rounded">bazel query --output=graph</code></li>
            <li>Simple arrow format: <code className="bg-gray-700 px-0.5 rounded">source -&gt; target</code> (one per line)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
