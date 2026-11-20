import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  ImageOff,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { apiRequest, formatUsd } from '../lib/api.ts';
import type {
  BlueprintRecord,
  BuildJobRecord,
  CreateWebsiteInput,
  DryRunBrief,
  McpSetupStatus,
  QaCheckRecord,
  QaScoreSummary,
  ValidationResult,
  WebsiteRecord,
} from '../shared/types.ts';
import { StatusIndicator } from '../components/StatusBadge.tsx';
import { useToast } from '../components/Toast.tsx';

const PIPELINE_STEPS = [
  '1. Site Configuration',
  '2. Validation',
  '3. MCP Dry-run',
  '4. Build Brief',
  '5. User Approval',
  '6. MCP Build',
  '7. Status Monitoring',
  '8. QA',
  '9. Publish Approval',
];

const US_LOAN_NICHES = [
  'Mortgage & Homebuyer Education',
  'Personal Loans & Debt Consolidation',
  'Small Business & SBA Financing',
  'VA Loans & Military Housing',
  'HELOC & Home Equity Education',
  'Auto Loan Refinancing Education',
  'Student Loan Refinance Guide',
];

interface CreateWebsitePageProps {
  initialBlueprint?: BlueprintRecord | null;
  resumeWebsite?: WebsiteRecord | null;
  onFinishedToWebsites: (websiteId: string) => void;
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function CreateWebsitePage({
  initialBlueprint,
  resumeWebsite,
  onFinishedToWebsites,
}: CreateWebsitePageProps) {
  const { pushToast } = useToast();
  const [stepIdx, setStepIdx] = useState(0);
  const [blueprints, setBlueprints] = useState<BlueprintRecord[]>([]);
  const [websiteId, setWebsiteId] = useState<string | undefined>(resumeWebsite?.id);
  const [activeWebsite, setActiveWebsite] = useState<WebsiteRecord | null>(
    resumeWebsite ?? null
  );

  const [form, setForm] = useState({
    brandName: resumeWebsite?.brandName || '',
    domain: resumeWebsite?.domain || '',
    niche: resumeWebsite?.niche || initialBlueprint?.niche || US_LOAN_NICHES[0],
    siteType: (resumeWebsite?.siteType === 'state' ? 'state' : 'city') as 'city' | 'state',
    locationCity: resumeWebsite?.locationCity || '',
    locationState: resumeWebsite?.locationState || '',
    email: '',
    phone: '',
    cloudflareAccount: '',
    testBuild: false,
    noindex: false,
    keywordsText:
      resumeWebsite?.keywords.join('\n') ||
      initialBlueprint?.defaultKeywords.join('\n') ||
      'FHA loan requirements\nfirst time homebuyer grants',
    servicesText:
      resumeWebsite?.services.join('\n') ||
      initialBlueprint?.defaultServices.join('\n') ||
      'FHA Loan Eligibility Guides\nDown Payment Assistance Directory',
    areasText: resumeWebsite?.serviceAreas.join('\n') || '',
    blogsText:
      resumeWebsite?.blogTopics.join('\n') ||
      initialBlueprint?.defaultBlogTopics.join('\n') ||
      '2026 Loan Limits and Credit Score Rules\nComparing Fixed vs Variable APR Options',
    blueprintId: resumeWebsite?.blueprintId || initialBlueprint?.id || '',
    disclosureText:
      resumeWebsite?.disclosureText ||
      initialBlueprint?.disclosureTemplate ||
      'Educational Resource Notice: This site provides US loan education and connects consumers with licensed lending partners. Not a direct lender or commitment to lend.',
  });

  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [brief, setBrief] = useState<DryRunBrief | null>(
    resumeWebsite?.dryRunBrief ?? null
  );
  const [approvalChecked, setApprovalChecked] = useState(false);
  const [latestJob, setLatestJob] = useState<BuildJobRecord | null>(null);
  const [qaChecks, setQaChecks] = useState<QaCheckRecord[]>([]);
  const [qaSummary, setQaSummary] = useState<QaScoreSummary | null>(
    resumeWebsite?.qaSummary ?? null
  );
  const [publishOverride, setPublishOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cloudflareAccounts, setCloudflareAccounts] = useState<
    Array<{ id: string; label: string }>
  >([]);

  useEffect(() => {
    apiRequest<{ blueprints: BlueprintRecord[] }>('/api/blueprints')
      .then((res) => setBlueprints(res.blueprints))
      .catch(() => undefined);
    apiRequest<McpSetupStatus>('/api/mcp/setup-status')
      .then((status) => {
        const accounts = status.remoteAccount?.cloudflareAccounts || [];
        setCloudflareAccounts(accounts);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!resumeWebsite) return;
    setWebsiteId(resumeWebsite.id);
    setActiveWebsite(resumeWebsite);
    setBrief(resumeWebsite.dryRunBrief);
    setQaSummary(resumeWebsite.qaSummary);
    setForm({
      brandName: resumeWebsite.brandName,
      domain: resumeWebsite.domain,
      niche: resumeWebsite.niche,
      siteType: resumeWebsite.siteType === 'state' ? 'state' : 'city',
      locationCity: resumeWebsite.locationCity,
      locationState: resumeWebsite.locationState,
      email: '',
      phone: '',
      cloudflareAccount: '',
      testBuild: false,
      noindex: false,
      keywordsText: resumeWebsite.keywords.join('\n'),
      servicesText: resumeWebsite.services.join('\n'),
      areasText: resumeWebsite.serviceAreas.join('\n'),
      blogsText: resumeWebsite.blogTopics.join('\n'),
      blueprintId: resumeWebsite.blueprintId || '',
      disclosureText: resumeWebsite.disclosureText || '',
    });

    const stageMap: Record<string, number> = {
      configuration: 0,
      validation: 1,
      dry_run: 2,
      build_brief: 3,
      user_approval: 4,
      mcp_build: 5,
      monitoring: 6,
      qa: 7,
      publish_approval: 8,
      published: 8,
    };
    setStepIdx(stageMap[resumeWebsite.workflowStage] ?? 0);
  }, [resumeWebsite]);

  const applyBlueprint = (bpId: string) => {
    const bp = blueprints.find((b) => b.id === bpId);
    if (!bp) {
      setForm((p) => ({ ...p, blueprintId: '' }));
      return;
    }
    setForm((p) => ({
      ...p,
      blueprintId: bp.id,
      niche: bp.niche,
      keywordsText: bp.defaultKeywords.join('\n'),
      servicesText: bp.defaultServices.join('\n'),
      blogsText: bp.defaultBlogTopics.join('\n'),
      disclosureText: bp.disclosureTemplate,
    }));
    pushToast(`Applied blueprint: ${bp.name}`, 'info');
  };

  const buildInputPayload = (): CreateWebsiteInput => ({
    brandName: form.brandName.trim(),
    domain: form.domain.trim(),
    niche: form.niche.trim(),
    siteType: form.siteType,
    locationCity: form.locationCity.trim(),
    locationState: form.locationState.trim().toUpperCase(),
    email: form.email.trim() || undefined,
    phone: form.phone.trim() || undefined,
    cloudflareAccount: form.cloudflareAccount || undefined,
    testBuild: form.testBuild,
    noindex: form.noindex,
    keywords: splitLines(form.keywordsText),
    services: splitLines(form.servicesText),
    serviceAreas: splitLines(form.areasText),
    blogTopics: splitLines(form.blogsText),
    blueprintId: form.blueprintId || null,
    disclosureText: form.disclosureText.trim(),
  });

  // Step 1 -> Step 2: Run Validation
  const handleRunValidation = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<ValidationResult>('/api/websites/validate', {
        method: 'POST',
        body: JSON.stringify({
          excludeWebsiteId: websiteId,
          input: buildInputPayload(),
        }),
      });
      setValidation(res);
      setStepIdx(1);
      if (!res.valid) {
        pushToast('Validation found issues to fix', 'error');
      } else {
        pushToast('Configuration validated', 'success');
      }
    } catch (err) {
      pushToast(
        'Validation error',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  // Step 2 -> Step 3 & 4: Run MCP Dry-run -> Build Brief
  const handleRunDryRun = async () => {
    setBusy(true);
    setStepIdx(2);
    try {
      const res = await apiRequest<{
        mode: string;
        isDemo: boolean;
        website: WebsiteRecord;
        dryRunBrief: DryRunBrief;
      }>('/api/mcp/create-website', {
        method: 'POST',
        body: JSON.stringify({
          websiteId,
          dryRun: true,
          input: buildInputPayload(),
        }),
      });
      setWebsiteId(res.website.id);
      setActiveWebsite(res.website);
      setBrief(res.dryRunBrief);
      setStepIdx(3);
      pushToast(
        res.isDemo ? 'MCP Dry-run completed (DEMO MODE)' : 'MCP Dry-run completed',
        'success'
      );
    } catch (err) {
      setStepIdx(1);
      pushToast(
        'MCP Dry-run failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  // Step 5 -> Step 6 & 7: User Approval -> MCP Real Build -> Status Monitoring
  const handleExecuteRealBuild = async () => {
    if (!approvalChecked) {
      pushToast('Confirm the approval checkbox before starting build', 'error');
      return;
    }
    setBusy(true);
    setStepIdx(5);
    try {
      const res = await apiRequest<{
        mode: string;
        isDemo: boolean;
        website: WebsiteRecord;
        job?: BuildJobRecord;
      }>('/api/mcp/create-website', {
        method: 'POST',
        body: JSON.stringify({
          websiteId,
          dryRun: false,
          input: buildInputPayload(),
        }),
      });
      setWebsiteId(res.website.id);
      setActiveWebsite(res.website);
      if (res.job) setLatestJob(res.job);
      setStepIdx(6);
      pushToast(
        res.isDemo ? 'Build queued (DEMO MODE)' : 'Real MCP build queued',
        'success'
      );
    } catch (err) {
      setStepIdx(4);
      pushToast(
        'MCP Build failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  // Step 7: Refresh Monitoring Status
  const handleRefreshStatus = async () => {
    if (!websiteId) return;
    setBusy(true);
    try {
      const res = await apiRequest<{
        website: WebsiteRecord;
        latestJob: BuildJobRecord | null;
      }>('/api/mcp/website-status', {
        method: 'POST',
        body: JSON.stringify({ websiteId }),
      });
      setActiveWebsite(res.website);
      setLatestJob(res.latestJob);
      if (res.latestJob?.status === 'completed' || res.website.status === 'qa_review') {
        await handleLoadQa();
        setStepIdx(7);
        pushToast('Build completed and QA audit generated', 'success');
      }
    } catch (err) {
      pushToast(
        'Status check failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRetryImages = async () => {
    if (!websiteId) return;
    setBusy(true);
    try {
      const res = await apiRequest<{ website: WebsiteRecord; job: BuildJobRecord }>(
        '/api/mcp/retry-images',
        {
          method: 'POST',
          body: JSON.stringify({ websiteId }),
        }
      );
      setActiveWebsite(res.website);
      setLatestJob(res.job);
      pushToast('Image generation retried successfully', 'success');
    } catch (err) {
      pushToast(
        'Retry images failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  const handleLoadQa = async () => {
    if (!websiteId) return;
    setBusy(true);
    try {
      const res = await apiRequest<{
        checks: QaCheckRecord[];
        summary: QaScoreSummary;
      }>(`/api/qa/${websiteId}/run`, { method: 'POST' });
      setQaChecks(res.checks);
      setQaSummary(res.summary);
      setStepIdx(7);
    } catch (err) {
      pushToast(
        'QA audit failed',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!websiteId) return;
    setBusy(true);
    try {
      const res = await apiRequest<{ website: WebsiteRecord; publishedUrl: string }>(
        '/api/mcp/publish-website',
        {
          method: 'POST',
          body: JSON.stringify({ websiteId, overrideQa: publishOverride }),
        }
      );
      setActiveWebsite(res.website);
      pushToast(res.website.status === 'published' ? 'Website published' : 'Deployment requested — check status for completion', res.website.status === 'published' ? 'success' : 'info', res.publishedUrl || undefined);
    } catch (err) {
      pushToast(
        'Publish blocked',
        'error',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Create Website Pipeline
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Gated 9-stage workflow from US loan site configuration through MCP dry-run, approval, QA, and publish.
        </p>
      </div>

      {/* 9-Stage Stepper */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 overflow-x-auto">
        <div className="flex items-center gap-1.5 min-w-max">
          {PIPELINE_STEPS.map((label, idx) => {
            const isCurrent = idx === stepIdx;
            const isDone = idx < stepIdx;
            const canClick =
              idx === 0 ||
              (idx === 1 && Boolean(validation)) ||
              (idx <= 4 && Boolean(brief)) ||
              (idx <= 8 && Boolean(websiteId));

            return (
              <button
                key={label}
                type="button"
                disabled={!canClick}
                onClick={() => canClick && setStepIdx(idx)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  isCurrent
                    ? 'bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950'
                    : isDone
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300'
                      : 'text-zinc-500 dark:text-zinc-400 disabled:opacity-45'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Stage 1: Site Configuration */}
      {stepIdx === 0 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-zinc-200 dark:border-zinc-800">
            <div>
              <h2 className="font-display text-base font-semibold">
                Stage 1 · Site Configuration
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Define brand identity, US target market, loan topics, and compliance disclosure.
              </p>
            </div>
            <div className="w-full sm:w-64">
              <select
                value={form.blueprintId}
                onChange={(e) => applyBlueprint(e.target.value)}
                aria-label="Prefill from Blueprint"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-xs"
              >
                <option value="">Load from Blueprint (optional)</option>
                {blueprints.map((bp) => (
                  <option key={bp.id} value={bp.id}>
                    {bp.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Brand Name</label>
              <input
                type="text"
                value={form.brandName}
                onChange={(e) => setForm((p) => ({ ...p, brandName: e.target.value }))}
                placeholder="e.g. Buckeye Home Loans Edu"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Root Domain</label>
              <input
                type="text"
                value={form.domain}
                onChange={(e) => setForm((p) => ({ ...p, domain: e.target.value }))}
                placeholder="e.g. buckeyehomeloansedu.com"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">US Loan Niche</label>
              <input
                type="text"
                list="us-loan-niche-options"
                value={form.niche}
                onChange={(e) => setForm((p) => ({ ...p, niche: e.target.value }))}
                placeholder="Select or type any niche"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
              />
              <datalist id="us-loan-niche-options">
                {US_LOAN_NICHES.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium mb-1">
                  Primary City {form.siteType === 'state' ? '(optional for statewide)' : ''}
                </label>
                <input
                  type="text"
                  value={form.locationCity}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, locationCity: e.target.value }))
                  }
                  placeholder={form.siteType === 'state' ? 'Optional' : 'e.g. Columbus'}
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">State</label>
                <input
                  type="text"
                  maxLength={2}
                  value={form.locationState}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      locationState: e.target.value.toUpperCase(),
                    }))
                  }
                  placeholder="OH"
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
                />
              </div>
            </div>

            <div className={cloudflareAccounts.length > 0 ? 'grid grid-cols-2 gap-3' : ''}>
              <div>
                <label className="block text-xs font-medium mb-1">Site Scope</label>
                <select
                  value={form.siteType}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      siteType: e.target.value as 'city' | 'state',
                    }))
                  }
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
                >
                  <option value="city">City-Focused Local Site</option>
                  <option value="state">Statewide Directory Site</option>
                </select>
              </div>
              {cloudflareAccounts.length > 0 && (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    Cloudflare Account
                  </label>
                  <select
                    value={form.cloudflareAccount}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, cloudflareAccount: e.target.value }))
                    }
                    className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
                  >
                    <option value="">Default ({cloudflareAccounts[0].label})</option>
                    {cloudflareAccounts.map((acc) => (
                      <option key={acc.id} value={acc.label}>
                        {acc.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">
                  Contact Email (optional)
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="info@domain.com"
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  Phone (optional)
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                  placeholder="(614) 555-0192"
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-1">
            <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.testBuild}
                onChange={(e) =>
                  setForm((p) => ({ ...p, testBuild: e.target.checked }))
                }
                className="rounded border-zinc-300"
              />
              <span>Test build (reduced sample pages for low-cost verification)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.noindex}
                onChange={(e) =>
                  setForm((p) => ({ ...p, noindex: e.target.checked }))
                }
                className="rounded border-zinc-300"
              />
              <span>Build as noindex until QA review passes</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                Target Keywords (one per line)
              </label>
              <textarea
                rows={4}
                value={form.keywordsText}
                onChange={(e) =>
                  setForm((p) => ({ ...p, keywordsText: e.target.value }))
                }
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Educational Services / Silos (one per line)
              </label>
              <textarea
                rows={4}
                value={form.servicesText}
                onChange={(e) =>
                  setForm((p) => ({ ...p, servicesText: e.target.value }))
                }
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Service Areas / Metros (one per line)
              </label>
              <textarea
                rows={3}
                value={form.areasText}
                onChange={(e) => setForm((p) => ({ ...p, areasText: e.target.value }))}
                placeholder="Columbus, OH&#10;Cleveland, OH&#10;Cincinnati, OH"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Initial Blog Topics (one per line)
              </label>
              <textarea
                rows={3}
                value={form.blogsText}
                onChange={(e) => setForm((p) => ({ ...p, blogsText: e.target.value }))}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              US Non-Lender &amp; Referral Disclosure Statement
            </label>
            <textarea
              rows={2}
              value={form.disclosureText}
              onChange={(e) =>
                setForm((p) => ({ ...p, disclosureText: e.target.value }))
              }
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-xs"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={handleRunValidation}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50"
            >
              <span>{busy ? 'Validating...' : 'Validate Configuration'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Stage 2: Validation */}
      {stepIdx === 1 && validation && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold">
                Stage 2 · Validation &amp; Compliance Guardrails
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Server-side check for domain uniqueness, structure, and US lending claim hygiene.
              </p>
            </div>
            <StatusIndicator status={validation.valid ? 'pass' : 'fail'} />
          </div>

          <div className="divide-y divide-zinc-200 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-md">
            {validation.complianceChecks.map((c) => (
              <div
                key={c.label}
                className="px-4 py-3 flex items-center justify-between gap-4 text-xs"
              >
                <div>
                  <div className="font-medium text-zinc-950 dark:text-zinc-50">
                    {c.label}
                  </div>
                  <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">{c.detail}</div>
                </div>
                {c.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-600 shrink-0" />
                )}
              </div>
            ))}
          </div>

          {validation.issues.length > 0 && (
            <div className="space-y-2">
              {validation.issues.map((issue, i) => (
                <div
                  key={i}
                  className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 ${
                    issue.severity === 'error'
                      ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                      : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => setStepIdx(0)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Edit Configuration</span>
            </button>

            <button
              type="button"
              disabled={!validation.valid || busy}
              onClick={handleRunDryRun}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium disabled:opacity-45"
            >
              <span>Run MCP Dry-run</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Stage 3: Running Dry-run */}
      {stepIdx === 2 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-10 text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-zinc-700 dark:text-zinc-300" />
          <div className="font-display text-sm font-semibold">
            Executing LocalSites.pro MCP Dry-run...
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Calculating page tree, image slots, compliance disclosures, and AI cost projection.
          </p>
        </div>
      )}

      {/* Stage 4: Build Brief */}
      {stepIdx === 3 && brief && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold">
                Stage 4 · Build Brief {brief.isDemo ? '(DEMO MODE)' : ''}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Inspect projected site architecture and AI cost estimate before approving build.
              </p>
            </div>
            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {form.domain}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">Est. Pages</div>
              <div className="font-mono text-lg font-semibold tabular-nums mt-1">
                {brief.estimatedPages}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">Est. Images</div>
              <div className="font-mono text-lg font-semibold tabular-nums mt-1">
                {brief.estimatedImages}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">Est. Total Cost</div>
              <div className="font-mono text-lg font-semibold tabular-nums mt-1">
                {formatUsd(brief.estimatedTotalCostUsd)}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">Est. Duration</div>
              <div className="font-mono text-lg font-semibold tabular-nums mt-1">
                ~{brief.estimatedDurationMinutes}m
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold mb-2">Planned Page Architecture</h3>
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-md">
              {brief.siteArchitecture.map((node) => (
                <div key={node.path} className="px-4 py-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <div>
                    <span className="font-mono text-blue-600 dark:text-blue-400 mr-2">
                      {node.path}
                    </span>
                    <span className="font-medium text-zinc-950 dark:text-zinc-50">
                      {node.title}
                    </span>
                  </div>
                  <span className="text-zinc-500 dark:text-zinc-400">{node.purpose}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs space-y-1 text-zinc-600 dark:text-zinc-400">
            {brief.complianceNotes.map((note) => (
              <div key={note} className="flex items-center gap-2">
                <FileCheck2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>{note}</span>
              </div>
            ))}
          </div>

          {brief.warnings && brief.warnings.length > 0 && (
            <div className="space-y-1.5">
              {brief.warnings.map((w, idx) => (
                <div
                  key={idx}
                  className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {brief.rawMcpSummary && (
            <div>
              <h3 className="text-xs font-semibold mb-2">
                LocalSites.pro MCP Dry-run Response
              </h3>
              <pre className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 text-xs font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
                {brief.rawMcpSummary}
              </pre>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStepIdx(0)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Modify Config</span>
            </button>
            <button
              type="button"
              onClick={() => setStepIdx(4)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
            >
              <span>Proceed to User Approval</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Stage 5: User Approval */}
      {stepIdx === 4 && brief && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <h2 className="font-display text-base font-semibold">
            Stage 5 · Owner Build Approval
          </h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            Reviewing <span className="font-medium text-zinc-950 dark:text-zinc-50">{form.brandName}</span>{' '}
            (<span className="font-mono">{form.domain}</span>). Approving this gate executes{' '}
            <span className="font-mono">create_website(dry_run=false)</span>{' '}
            {brief.isDemo ? 'in DEMO MODE.' : 'against your live LocalSites.pro MCP server.'}
          </p>

          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-zinc-500">Content estimate ({brief.estimatedContentTokens.toLocaleString()} tokens)</span>
              <span className="font-mono">{formatUsd(brief.estimatedContentCostUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Image estimate ({brief.estimatedImages} assets)</span>
              <span className="font-mono">{formatUsd(brief.estimatedImageCostUsd)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-zinc-200 dark:border-zinc-800 font-semibold">
              <span>Projected Total</span>
              <span className="font-mono">{formatUsd(brief.estimatedTotalCostUsd)}</span>
            </div>
          </div>

          <label className="flex items-start gap-2.5 text-xs text-zinc-800 dark:text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={approvalChecked}
              onChange={(e) => setApprovalChecked(e.target.checked)}
              className="mt-0.5 rounded border-zinc-300"
            />
            <span>
              I approve this US loan education site brief, compliance disclosures, and projected AI build budget.
            </span>
          </label>

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStepIdx(3)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Brief</span>
            </button>
            <button
              type="button"
              disabled={!approvalChecked || busy}
              onClick={handleExecuteRealBuild}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-45"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Approve &amp; Start MCP Build</span>
            </button>
          </div>
        </div>
      )}

      {/* Stage 6: Dispatching MCP Build */}
      {stepIdx === 5 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-10 text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600" />
          <div className="font-display text-sm font-semibold">
            Dispatching Build to LocalSites.pro MCP...
          </div>
        </div>
      )}

      {/* Stage 7: Status Monitoring */}
      {stepIdx === 6 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold">
                Stage 7 · Build Status Monitoring
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Poll <span className="font-mono">get_website_status</span> to advance build and trigger QA.
              </p>
            </div>
            <StatusIndicator status={latestJob?.status || activeWebsite?.status || 'building'} />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs font-mono">
              <span>{latestJob?.currentStep || 'Build queued and running...'}</span>
              <span>{latestJob?.progressPct ?? 25}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${latestJob?.progressPct ?? 25}%` }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleRetryImages}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
            >
              <ImageOff className="w-3.5 h-3.5" />
              <span>Retry Website Images</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={handleRefreshStatus}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
                <span>Refresh Status</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleLoadQa}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Run QA Audit</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 8: QA */}
      {stepIdx === 7 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold">
                Stage 8 · Pre-Publish QA Validation
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                SEO, content, canonical URLs, US loan disclosures, images, and link checks.
              </p>
            </div>
            {qaSummary && (
              <span className="font-mono text-xs font-medium">
                {qaSummary.passed}/{qaSummary.total} passed
              </span>
            )}
          </div>

          {qaChecks.length === 0 ? (
            <div className="py-6 text-center">
              <button
                type="button"
                onClick={handleLoadQa}
                className="px-4 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
              >
                Run Full QA Audit
              </button>
            </div>
          ) : (
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-md">
              {qaChecks.map((qc) => (
                <div
                  key={qc.id}
                  className="px-4 py-3 flex items-start justify-between gap-4 text-xs"
                >
                  <div>
                    <div className="font-medium text-zinc-950 dark:text-zinc-50">
                      {qc.category.toUpperCase()} · {qc.title}
                    </div>
                    <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {qc.details}
                    </div>
                  </div>
                  <StatusIndicator status={qc.status} />
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleLoadQa}
              className="px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
            >
              Re-run QA
            </button>
            <button
              type="button"
              onClick={() => setStepIdx(8)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
            >
              <span>Continue to Publish Approval</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Stage 9: Publish Approval */}
      {stepIdx === 8 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold">
                Stage 9 · Final Publish Approval
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Confirm final release via <span className="font-mono">publish_website</span>.
              </p>
            </div>
            {activeWebsite && <StatusIndicator status={activeWebsite.status} />}
          </div>

          {activeWebsite?.status === 'published' ? (
            <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 p-4 space-y-2">
              <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                Website Published {activeWebsite.isDemo ? '(DEMO MODE)' : 'Live'}
              </div>
              <div className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
                {activeWebsite.publishedUrl}
              </div>
              <button
                type="button"
                onClick={() => onFinishedToWebsites(activeWebsite.id)}
                className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-950 dark:bg-zinc-50 text-zinc-50 dark:text-zinc-950 text-xs font-medium"
              >
                <span>Open in Websites Portfolio</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
              {qaSummary && qaSummary.failed > 0 && (
                <label className="flex items-start gap-2.5 text-xs text-amber-800 dark:text-amber-300 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3">
                  <input
                    type="checkbox"
                    checked={publishOverride}
                    onChange={(e) => setPublishOverride(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    {qaSummary.failed} QA check(s) failed. Check to explicitly override QA blocking for this publish.
                  </span>
                </label>
              )}

              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStepIdx(7)}
                  className="px-3.5 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs font-medium"
                >
                  Back to QA
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handlePublish}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Rocket className="w-3.5 h-3.5" />
                  <span>{busy ? 'Publishing...' : 'Approve & Publish Website'}</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
