import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  ImageOff,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  apiRequest,
  formatRelativeDate,
  WORKFLOW_STAGE_LABELS,
} from '../lib/api.ts';
import type { WebsiteRecord, WebsiteStatus } from '../shared/types.ts';
import { StatusIndicator } from '../components/StatusBadge.tsx';
import { useToast } from '../components/Toast.tsx';
import type { PageKey } from '../components/Sidebar.tsx';

interface WebsitesPageProps {
  selectedWebsiteId: string | null;
  onSelectWebsite: (id: string | null) => void;
  onNavigate: (page: PageKey) => void;
  onOpenQaForSite: (websiteId: string) => void;
  onResumeCreateWorkflow: (website: WebsiteRecord) => void;
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'published', label: 'Published' },
  { value: 'building', label: 'Building' },
  { value: 'qa_review', label: 'QA Review' },
  { value: 'awaiting_approval', label: 'Approval' },
  { value: 'failed', label: 'Failed' },
];

export function WebsitesPage({
  selectedWebsiteId,
  onSelectWebsite,
  onNavigate,
  onOpenQaForSite,
  onResumeCreateWorkflow,
}: WebsitesPageProps) {
  const { pushToast } = useToast();
  const [websites, setWebsites] = useState<WebsiteRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [nicheFilter, setNicheFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'live' | 'demo'>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'brand' | 'indexed'>('updated');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [syncing, setSyncing] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const [cloneSource, setCloneSource] = useState<WebsiteRecord | null>(null);
  const [clonePlan, setClonePlan] = useState<string | null>(null);
  const [cloneForm, setCloneForm] = useState({
    newBrandName: '',
    newDomain: '',
    locationCity: '',
    locationState: '',
  });

  const loadWebsites = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ websites: WebsiteRecord[] }>('/api/websites');
      setWebsites(res.websites);
    } catch (err) {
      pushToast(
        'Failed to load websites',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWebsites();
  }, []);

  const niches = useMemo(() => {
    const set = new Set<string>();
    websites.forEach((w) => set.add(w.niche));
    return Array.from(set).sort();
  }, [websites]);

  const counts = useMemo(() => {
    const live = websites.filter((w) => !w.isDemo).length;
    const demo = websites.length - live;
    return { total: websites.length, live, demo };
  }, [websites]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = websites.filter((w) => {
      if (statusFilter !== 'all' && w.status !== (statusFilter as WebsiteStatus)) {
        return false;
      }
      if (nicheFilter !== 'all' && w.niche !== nicheFilter) {
        return false;
      }
      if (sourceFilter === 'live' && w.isDemo) {
        return false;
      }
      if (sourceFilter === 'demo' && !w.isDemo) {
        return false;
      }
      if (!q) return true;
      return (
        w.brandName.toLowerCase().includes(q) ||
        w.domain.toLowerCase().includes(q) ||
        w.niche.toLowerCase().includes(q) ||
        w.locationCity.toLowerCase().includes(q) ||
        w.locationState.toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => {
      if (sortBy === 'brand') return a.brandName.localeCompare(b.brandName);
      if (sortBy === 'indexed') return (b.indexedPages ?? -1) - (a.indexedPages ?? -1);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [websites, search, statusFilter, nicheFilter, sourceFilter, sortBy]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, nicheFilter, sourceFilter, sortBy, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedWebsites = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize]);

  const activeSite = useMemo(
    () => websites.find((w) => w.id === selectedWebsiteId) || null,
    [websites, selectedWebsiteId]
  );

  const handleMcpSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest<{
        mode: string;
        isDemo: boolean;
        syncedCount?: number;
        remoteCount?: number;
        websites: WebsiteRecord[];
      }>('/api/mcp/list-websites', { method: 'POST' });
      setWebsites(res.websites);
      pushToast(
        res.isDemo
          ? 'Synced websites (DEMO MODE)'
          : `Synced ${res.syncedCount ?? res.remoteCount ?? res.websites.length} live websites from LocalSites.pro`,
        'success'
      );
    } catch (err) {
      pushToast(
        'MCP sync failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleRunQaAudit = async (site: WebsiteRecord) => {
    setActionBusy(`qa-${site.id}`);
    try {
      const res = await apiRequest<{
        summary: { passed: number; warned: number; failed: number; total: number };
      }>(`/api/qa/${site.id}/run`, { method: 'POST' });
      await loadWebsites();
      pushToast(
        `QA Audit: ${res.summary.passed}/${res.summary.total} passed`,
        res.summary.failed > 0 ? 'info' : 'success',
        site.publishedUrl && !site.isDemo
          ? `Scanned live HTML at ${site.publishedUrl}`
          : 'Configuration audit completed'
      );
    } catch (err) {
      pushToast(
        'QA audit failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  const handleStopBuild = async (site: WebsiteRecord) => {
    setActionBusy(`stop-${site.id}`);
    try {
      const res = await apiRequest<{ website: WebsiteRecord }>(
        '/api/mcp/stop-build',
        {
          method: 'POST',
          body: JSON.stringify({ websiteId: site.id }),
        }
      );
      setWebsites((prev) =>
        prev.map((w) => (w.id === site.id ? res.website : w))
      );
      pushToast(`Stopped build for ${site.brandName}`, 'info');
    } catch (err) {
      pushToast(
        'Stop build failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  const handleCheckStatus = async (site: WebsiteRecord) => {
    setActionBusy(`status-${site.id}`);
    try {
      const res = await apiRequest<{ website: WebsiteRecord }>(
        '/api/mcp/website-status',
        {
          method: 'POST',
          body: JSON.stringify({ websiteId: site.id }),
        }
      );
      setWebsites((prev) =>
        prev.map((w) => (w.id === site.id ? res.website : w))
      );
      pushToast(`Status updated for ${site.brandName}`, 'info');
    } catch (err) {
      pushToast(
        'Status check failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  const handleRetryImages = async (site: WebsiteRecord) => {
    setActionBusy(`img-${site.id}`);
    try {
      const res = await apiRequest<{ website: WebsiteRecord }>(
        '/api/mcp/retry-images',
        {
          method: 'POST',
          body: JSON.stringify({ websiteId: site.id }),
        }
      );
      setWebsites((prev) =>
        prev.map((w) => (w.id === site.id ? res.website : w))
      );
      pushToast(`Image retry completed for ${site.brandName}`, 'success');
    } catch (err) {
      pushToast(
        'Image retry failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  const handlePublish = async (site: WebsiteRecord) => {
    setActionBusy(`pub-${site.id}`);
    try {
      const res = await apiRequest<{ website: WebsiteRecord; publishedUrl: string }>(
        '/api/mcp/publish-website',
        {
          method: 'POST',
          body: JSON.stringify({ websiteId: site.id }),
        }
      );
      setWebsites((prev) =>
        prev.map((w) => (w.id === site.id ? res.website : w))
      );
      pushToast(`Published ${site.brandName}`, 'success', res.publishedUrl);
    } catch (err) {
      pushToast(
        'Publish blocked',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  const handleDelete = async (site: WebsiteRecord) => {
    setActionBusy(`del-${site.id}`);
    try {
      await apiRequest(`/api/websites/${site.id}`, { method: 'DELETE' });
      setWebsites((prev) => prev.filter((w) => w.id !== site.id));
      if (selectedWebsiteId === site.id) onSelectWebsite(null);
      pushToast(`Removed ${site.brandName}`, 'info');
    } catch (err) {
      pushToast(
        'Delete failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  const openCloneModal = (site: WebsiteRecord) => {
    setCloneSource(site);
    setClonePlan(null);
    setCloneForm({
      newBrandName: `${site.brandName} Metro`,
      newDomain: `metro-${site.domain}`,
      locationCity: site.locationCity,
      locationState: site.locationState,
    });
  };

  const submitClone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloneSource) return;
    setActionBusy('clone');
    try {
      const dryRun = !clonePlan;
      const res = await apiRequest<{
        dryRun: boolean;
        isDemo: boolean;
        plan?: Record<string, unknown>;
        website?: WebsiteRecord;
      }>('/api/mcp/clone-website', {
        method: 'POST',
        body: JSON.stringify({
          sourceWebsiteId: cloneSource.id,
          ...cloneForm,
          dryRun,
        }),
      });
      if (dryRun) {
        setClonePlan(JSON.stringify(res.plan || {}, null, 2));
        pushToast('Clone dry-run ready for review', 'success');
      } else if (res.website) {
        setWebsites((prev) => [res.website!, ...prev]);
        setCloneSource(null);
        setClonePlan(null);
        onSelectWebsite(res.website.id);
        pushToast(
          res.isDemo ? 'Demo clone draft created' : 'Clone draft created — not built yet',
          'success'
        );
      } else {
        throw new Error('LocalSites.pro did not return a created draft.');
      }
    } catch (err) {
      pushToast(
        'Clone failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            Websites Portfolio
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 tabular-nums">
            {counts.total} total · {counts.live} Live MCP · {counts.demo} Demo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={syncing}
            onClick={handleMcpSync}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            <span>Sync MCP</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('create')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Website</span>
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 bg-zinc-100 dark:bg-zinc-950 p-1 rounded-md">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                statusFilter === f.value
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
          <select
            value={sourceFilter}
            onChange={(e) =>
              setSourceFilter(e.target.value as 'all' | 'live' | 'demo')
            }
            aria-label="Filter by source"
            className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200"
          >
            <option value="all">All sources</option>
            <option value="live">Live MCP</option>
            <option value="demo">Demo</option>
          </select>

          <select
            value={nicheFilter}
            onChange={(e) => setNicheFilter(e.target.value)}
            aria-label="Filter by loan niche"
            className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 max-w-[180px]"
          >
            <option value="all">All niches</option>
            {niches.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={(e) =>
              setSortBy(e.target.value as 'updated' | 'brand' | 'indexed')
            }
            aria-label="Sort websites"
            className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200"
          >
            <option value="updated">Sort: Updated</option>
            <option value="indexed">Sort: Indexed Pages</option>
            <option value="brand">Sort: Brand A–Z</option>
          </select>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search brand, domain, state..."
              className="w-full sm:w-56 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 pl-8 pr-3 py-1.5 text-xs text-zinc-950 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            />
          </div>
        </div>
      </div>

      {/* Websites Table */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-10 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              No matching websites found
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Adjust your filters or launch the Create Website workflow.
            </p>
            <button
              type="button"
              onClick={() => onNavigate('create')}
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Website</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <th className="py-2.5 px-4">Brand &amp; Domain</th>
                  <th className="py-2.5 px-4">Niche &amp; Market</th>
                  <th className="py-2.5 px-4">Stage</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">QA</th>
                  <th className="py-2.5 px-4 text-right">Updated</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800 text-sm">
                {pagedWebsites.map((site) => (
                  <tr
                    key={site.id}
                    onClick={() => onSelectWebsite(site.id)}
                    className={`cursor-pointer transition-colors ${
                      selectedWebsiteId === site.id
                        ? 'bg-zinc-50 dark:bg-zinc-800/70'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                    }`}
                  >
                    <td className="py-3 px-4">
                      <div className="font-medium text-zinc-950 dark:text-zinc-50">
                        {site.brandName}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                        {site.domain}
                        {site.isDemo ? ' · DEMO' : ' · LIVE'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-xs text-zinc-800 dark:text-zinc-200">
                        {site.niche}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {site.locationCity ? `${site.locationCity}, ` : ''}
                        {site.locationState}
                        {site.siteType ? ` · ${site.siteType}` : ''}
                        {site.indexedPages != null
                          ? ` · ${site.indexedPages} indexed`
                          : ` · ${site.services.length} services`}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                      {WORKFLOW_STAGE_LABELS[site.workflowStage] || site.workflowStage}
                    </td>
                    <td className="py-3 px-4">
                      <StatusIndicator status={site.status} />
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                      {site.qaSummary
                        ? `${site.qaSummary.passed}/${site.qaSummary.total}`
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                      {formatRelativeDate(site.updatedAt)}
                    </td>
                    <td
                      className="py-3 px-4 text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openCloneModal(site)}
                          title="Clone website"
                          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenQaForSite(site.id)}
                          title="Inspect in QA Center"
                          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-400">
            <div className="font-mono tabular-nums">
              Showing {(safePage - 1) * pageSize + 1}–
              {Math.min(safePage * pageSize, filtered.length)} of {filtered.length} matching website(s)
            </div>
            <div className="flex items-center gap-2">
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label="Rows per page"
                className="rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300"
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="p-1.5 rounded border border-zinc-200 dark:border-zinc-800 disabled:opacity-40 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono tabular-nums px-1">
                {safePage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-1.5 rounded border border-zinc-200 dark:border-zinc-800 disabled:opacity-40 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                aria-label="Next page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Inspector Drawer */}
      {activeSite && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div
            className="fixed inset-0 bg-zinc-950/30"
            onClick={() => onSelectWebsite(null)}
            aria-hidden="true"
          />
          <div className="relative z-50 w-full max-w-lg bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 h-full overflow-y-auto p-6 flex flex-col justify-between gap-6">
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {activeSite.niche}
                    {activeSite.isDemo ? ' · DEMO MODE' : ' · LIVE MCP'}
                  </div>
                  <h2 className="font-display text-lg font-semibold text-zinc-950 dark:text-zinc-50 mt-0.5">
                    {activeSite.brandName}
                  </h2>
                  <p className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    {activeSite.domain} · {activeSite.locationCity}, {activeSite.locationState}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectWebsite(null)}
                  className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  aria-label="Close inspector"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-between py-2.5 border-y border-zinc-200 dark:border-zinc-800 text-xs">
                <StatusIndicator status={activeSite.status} />
                <span className="text-zinc-600 dark:text-zinc-400">
                  {WORKFLOW_STAGE_LABELS[activeSite.workflowStage]}
                </span>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onResumeCreateWorkflow(activeSite)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
                >
                  <span>Open Pipeline Stage</span>
                </button>

                <button
                  type="button"
                  disabled={actionBusy === `status-${activeSite.id}`}
                  onClick={() => handleCheckStatus(activeSite)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Check Status</span>
                </button>

                <button
                  type="button"
                  disabled={actionBusy === `img-${activeSite.id}`}
                  onClick={() => handleRetryImages(activeSite)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <ImageOff className="w-3.5 h-3.5" />
                  <span>Retry Images</span>
                </button>

                <button
                  type="button"
                  disabled={actionBusy === `qa-${activeSite.id}`}
                  onClick={() => handleRunQaAudit(activeSite)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <Play className="w-3 h-3" />
                  <span>{actionBusy === `qa-${activeSite.id}` ? 'Auditing...' : 'Run Live QA'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onOpenQaForSite(activeSite.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>QA Center</span>
                </button>

                <button
                  type="button"
                  onClick={() => openCloneModal(activeSite)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Clone</span>
                </button>

                {activeSite.status === 'building' && (
                  <button
                    type="button"
                    disabled={actionBusy === `stop-${activeSite.id}`}
                    onClick={() => handleStopBuild(activeSite)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 dark:border-red-900 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    <Square className="w-3 h-3" />
                    <span>Stop Build</span>
                  </button>
                )}

                {activeSite.status !== 'published' && (
                  <button
                    type="button"
                    disabled={actionBusy === `pub-${activeSite.id}`}
                    onClick={() => handlePublish(activeSite)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    <span>Publish</span>
                  </button>
                )}
              </div>

              {(activeSite.engine || activeSite.siteType || activeSite.indexedPages != null || activeSite.externalMcpId) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                  {activeSite.engine && <span>engine: {activeSite.engine}</span>}
                  {activeSite.siteType && <span>type: {activeSite.siteType}</span>}
                  {activeSite.indexedPages != null && (
                    <span className="tabular-nums">indexed: {activeSite.indexedPages}</span>
                  )}
                  {activeSite.externalMcpId && (
                    <span>site_id: {activeSite.externalMcpId}</span>
                  )}
                </div>
              )}

              {activeSite.publishedUrl && (
                <a
                  href={activeSite.publishedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 p-3 flex items-center justify-between text-xs hover:bg-emerald-100/70 dark:hover:bg-emerald-950/50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-emerald-900 dark:text-emerald-200">
                      Published URL {activeSite.isDemo ? '(Demo Simulation)' : '(Live)'}
                    </div>
                    <div className="font-mono text-emerald-700 dark:text-emerald-400 mt-0.5 truncate">
                      {activeSite.publishedUrl}
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 ml-2" />
                </a>
              )}

              <div className="space-y-4 text-xs">
                <div>
                  <h4 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                    Keywords
                  </h4>
                  <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">
                    {activeSite.keywords.join(' · ') || 'None specified'}
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                    Loan Education Services
                  </h4>
                  <ul className="list-disc list-inside text-zinc-600 dark:text-zinc-400 space-y-1">
                    {activeSite.services.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                    Service Areas
                  </h4>
                  <p className="text-zinc-600 dark:text-zinc-400">
                    {activeSite.serviceAreas.join(' · ')}
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                    Planned Blog Guides
                  </h4>
                  <ul className="list-disc list-inside text-zinc-600 dark:text-zinc-400 space-y-1">
                    {activeSite.blogTopics.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
                {activeSite.disclosureText && (
                  <div>
                    <h4 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                      US Financial Disclosure
                    </h4>
                    <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">
                      {activeSite.disclosureText}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
              <span className="font-mono text-xs text-zinc-400">
                ID: {activeSite.id.slice(0, 8)}
              </span>
              <button
                type="button"
                disabled={actionBusy === `del-${activeSite.id}`}
                onClick={() => handleDelete(activeSite)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Website</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clone Modal */}
      {cloneSource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/50">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-zinc-950 dark:text-zinc-50">
                Clone Website via MCP
              </h3>
              <button
                type="button"
                onClick={() => { setCloneSource(null); setClonePlan(null); }}
                className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Cloning structure, services, and compliance disclosures from{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {cloneSource.brandName}
              </span>
              .
            </p>
            <form onSubmit={submitClone} className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">New Brand Name</label>
                <input
                  type="text"
                  required
                  value={cloneForm.newBrandName}
                  onChange={(e) =>
                    { setClonePlan(null); setCloneForm((p) => ({ ...p, newBrandName: e.target.value })); }
                  }
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">New Root Domain</label>
                <input
                  type="text"
                  required
                  value={cloneForm.newDomain}
                  onChange={(e) =>
                    { setClonePlan(null); setCloneForm((p) => ({ ...p, newDomain: e.target.value })); }
                  }
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">City</label>
                  <input
                    type="text"
                    required
                    value={cloneForm.locationCity}
                    onChange={(e) =>
                      { setClonePlan(null); setCloneForm((p) => ({ ...p, locationCity: e.target.value })); }
                    }
                    className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">State (2-letter)</label>
                  <input
                    type="text"
                    required
                    maxLength={2}
                    value={cloneForm.locationState}
                    onChange={(e) => {
                      setClonePlan(null);
                      setCloneForm((p) => ({ ...p, locationState: e.target.value.toUpperCase() }));
                    }}
                    className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
                  />
                </div>
              </div>
              {clonePlan && (
                <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
                  <div className="text-xs font-semibold mb-2">LocalSites.pro Clone Dry-run Plan</div>
                  <pre className="text-[11px] whitespace-pre-wrap break-all max-h-52 overflow-auto">{clonePlan}</pre>
                  <p className="text-[11px] mt-2 text-amber-700 dark:text-amber-300">
                    Confirming creates a DRAFT only. No site build or image generation starts here.
                  </p>
                </div>
              )}
              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setCloneSource(null); setClonePlan(null); }}
                  className="px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionBusy === 'clone'}
                  className="px-3.5 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
                >
                  {actionBusy === 'clone' ? 'Working...' : clonePlan ? 'Confirm Clone Draft' : 'Preview Clone Dry-run'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
