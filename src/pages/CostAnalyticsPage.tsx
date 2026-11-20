import { useEffect, useMemo, useState } from 'react';
import { apiRequest, formatNumber, formatRelativeDate, formatUsd } from '../lib/api.ts';
import type { CostEntryRecord } from '../shared/types.ts';
import { useToast } from '../components/Toast.tsx';

interface PerWebsiteCost {
  websiteId: string;
  brandName: string;
  domain: string;
  niche: string;
  isDemo: boolean;
  contentUsd: number;
  imageUsd: number;
  estimatedUsd: number;
  actualUsd: number;
}

export function CostAnalyticsPage({
  onInspectWebsite,
}: {
  onInspectWebsite: (websiteId: string) => void;
}) {
  const { pushToast } = useToast();
  const [entries, setEntries] = useState<CostEntryRecord[]>([]);
  const [perWebsite, setPerWebsite] = useState<PerWebsiteCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState<'all' | 'content' | 'image' | 'provider_total'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'live' | 'demo'>('all');

  useEffect(() => {
    apiRequest<{ entries: CostEntryRecord[]; perWebsite: PerWebsiteCost[] }>('/api/costs')
      .then((res) => {
        setEntries(res.entries);
        setPerWebsite(res.perWebsite);
      })
      .catch((err) => {
        pushToast(
          'Failed to load cost analytics',
          'error',
          err instanceof Error ? err.message : undefined
        );
      })
      .finally(() => setLoading(false));
  }, [pushToast]);

  const filteredPerWebsite = useMemo(() => {
    return perWebsite.filter((row) => {
      if (sourceFilter === 'live' && row.isDemo) return false;
      if (sourceFilter === 'demo' && !row.isDemo) return false;
      return row.actualUsd > 0 || row.estimatedUsd > 0;
    });
  }, [perWebsite, sourceFilter]);

  const totals = useMemo(() => {
    const content = filteredPerWebsite.reduce((s, r) => s + r.contentUsd, 0);
    const image = filteredPerWebsite.reduce((s, r) => s + r.imageUsd, 0);
    const estimated = filteredPerWebsite.reduce((s, r) => s + r.estimatedUsd, 0);
    const actual = filteredPerWebsite.reduce((s, r) => s + r.actualUsd, 0);
    return { content, image, estimated, actual };
  }, [filteredPerWebsite]);

  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (catFilter !== 'all' && e.category !== catFilter) return false;
      if (sourceFilter === 'live' && e.isDemo) return false;
      if (sourceFilter === 'demo' && !e.isDemo) return false;
      return true;
    });
  }, [entries, catFilter, sourceFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            Cost Analytics
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Verified combined provider totals where reported; content/image breakdowns remain unknown until supplied by the provider.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-md bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 w-fit">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'live', label: 'Live MCP' },
              { id: 'demo', label: 'Demo' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSourceFilter(tab.id)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                sourceFilter === tab.id
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="text-xs text-zinc-500">Reported Actual Spend</div>
          <div className="font-mono text-2xl font-semibold tabular-nums mt-2">
            {formatUsd(totals.actual)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="text-xs text-zinc-500">Allocated Content Cost</div>
          <div className="font-mono text-2xl font-semibold tabular-nums mt-2">
            {formatUsd(totals.content)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="text-xs text-zinc-500">Allocated Image Cost</div>
          <div className="font-mono text-2xl font-semibold tabular-nums mt-2">
            {formatUsd(totals.image)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="text-xs text-zinc-500">Reported vs Estimated</div>
          <div className="font-mono text-2xl font-semibold tabular-nums mt-2">
            {totals.actual - totals.estimated >= 0 ? '+' : ''}
            {formatUsd(totals.actual - totals.estimated)}
          </div>
        </div>
      </div>

      {/* Per Website Breakdown */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3.5 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="font-display text-sm font-semibold">
            Spend Per Website
          </h2>
        </div>

        {loading ? (
          <div className="p-6 space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-10 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"
              />
            ))}
          </div>
        ) : filteredPerWebsite.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No AI spend recorded for this filter yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <th className="py-2.5 px-4">Website</th>
                  <th className="py-2.5 px-4 text-right">Content</th>
                  <th className="py-2.5 px-4 text-right">Images</th>
                  <th className="py-2.5 px-4 text-right">Estimated</th>
                  <th className="py-2.5 px-4 text-right">Actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800 text-sm">
                {filteredPerWebsite.map((row) => (
                  <tr
                    key={row.websiteId}
                    onClick={() => onInspectWebsite(row.websiteId)}
                    className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-zinc-950 dark:text-zinc-50">
                        {row.brandName}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                        {row.domain}
                        {row.isDemo ? ' · DEMO' : ' · LIVE'}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums">
                      {formatUsd(row.contentUsd)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums">
                      {formatUsd(row.imageUsd)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs tabular-nums text-zinc-500">
                      {formatUsd(row.estimatedUsd)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs font-semibold tabular-nums">
                      {formatUsd(row.actualUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Cost Ledger */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3">
          <h2 className="font-display text-sm font-semibold">Line-Item Ledger</h2>
          <div className="flex items-center gap-1 p-1 rounded bg-zinc-100 dark:bg-zinc-950">
            {(['all', 'content', 'image', 'provider_total'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCatFilter(c)}
                className={`px-2.5 py-1 rounded text-xs font-medium capitalize ${
                  catFilter === c
                    ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50'
                    : 'text-zinc-500'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <th className="py-2.5 px-4">Website</th>
                <th className="py-2.5 px-4">Category</th>
                <th className="py-2.5 px-4">Model</th>
                <th className="py-2.5 px-4 text-right">Units</th>
                <th className="py-2.5 px-4 text-right">Actual Cost</th>
                <th className="py-2.5 px-4 text-right">Recorded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800 text-xs">
              {filteredEntries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2.5 px-4 font-medium text-zinc-900 dark:text-zinc-100">
                    {e.websiteBrand}
                  </td>
                  <td className="py-2.5 px-4 capitalize text-zinc-600 dark:text-zinc-400">
                    {e.category}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-zinc-600 dark:text-zinc-400">
                    {e.providerModel}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                    {formatNumber(e.units)} {e.unitLabel}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono font-semibold tabular-nums">
                    {e.actualCostUsd === null ? 'Not reported' : formatUsd(e.actualCostUsd)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-zinc-500">
                    {formatRelativeDate(e.recordedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
