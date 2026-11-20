export interface RemoteBuildSnapshot {
  state: 'running' | 'completed' | 'failed';
  progressPct: number;
  currentStep: string;
  liveUrl: string | null;
  error: string | null;
  costUsd: number | null;
  imageFailure: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * LocalSites.pro returns a top-level status and a nested build state.
 * A website may be "deployed" while an image slot failed independently.
 */
export function readRemoteBuild(remote: Record<string, unknown>): RemoteBuildSnapshot {
  const build = asRecord(remote.build);
  const progress = asRecord(build.progress);
  const status = String(remote.status || '').toLowerCase();
  const buildState = String(build.state || '').toLowerCase();
  const explicitError = typeof build.error === 'string' && build.error.trim()
    ? build.error.trim()
    : typeof remote.error === 'string' && remote.error.trim()
      ? remote.error.trim()
      : null;

  const failed = ['failed', 'error', 'cancelled'].includes(status) ||
    ['failed', 'error', 'cancelled'].includes(buildState) || Boolean(explicitError);
  const completed = !failed && (
    ['done', 'completed', 'success', 'succeeded'].includes(buildState) ||
    (['deployed', 'published', 'live'].includes(status) && buildState !== 'running') ||
    (['ready', 'completed'].includes(status) && buildState !== 'running')
  );

  const steps = typeof build.steps_done === 'string'
    ? /^(\d+)\s*\/\s*(\d+)$/.exec(build.steps_done.trim())
    : null;
  let progressPct = 0;
  if (typeof remote.progress_pct === 'number') progressPct = remote.progress_pct;
  else if (typeof remote.progress === 'number') progressPct = remote.progress;
  else if (steps && Number(steps[2]) > 0) {
    progressPct = Math.round(100 * Number(steps[1]) / Number(steps[2]));
  } else if (completed) progressPct = 100;
  else if (failed) progressPct = 0;
  else progressPct = 10;
  progressPct = Math.max(0, Math.min(100, progressPct));
  if (completed) progressPct = 100;

  const imageEntry = progress.images;
  const imageFailure = typeof imageEntry === 'string' &&
    /failed|error|insufficient credits/i.test(imageEntry)
    ? imageEntry : null;
  const liveUrl = typeof remote.live_url === 'string' && remote.live_url.trim()
    ? remote.live_url.trim()
    : typeof remote.url === 'string' && remote.url.trim() ? remote.url.trim() : null;
  const currentStep = typeof progress.deploy === 'string' && progress.deploy.trim()
    ? progress.deploy.trim()
    : typeof remote.current_step === 'string' && remote.current_step.trim()
      ? remote.current_step.trim()
      : typeof remote.stage === 'string' && remote.stage.trim()
        ? remote.stage.trim()
        : `LocalSites.pro: ${status || buildState || 'processing'}`;

  return {
    state: failed ? 'failed' : completed ? 'completed' : 'running',
    progressPct,
    currentStep,
    liveUrl,
    error: explicitError || (failed ? currentStep : null),
    costUsd: numericCost(build.cost_usd) ?? numericCost(remote.cost_usd),
    imageFailure,
  };
}

function countPages(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') {
    const match = /^\s*(\d+)/.exec(value);
    if (match) return Number(match[1]);
    // LocalSites.pro may return "about, contact, privacy, terms, accessibility".
    return value.split(',').filter(Boolean).length;
  }
  return 0;
}

/** Prefer LocalSites.pro's nested dry-run brief over locally estimated page counts. */
export function readRemoteBrief(remote: Record<string, unknown>): {
  pages: number | null;
  summary: string;
  warnings: string[];
} {
  const brief = asRecord(remote.brief);
  const pages = asRecord(brief.pages);
  const hasPages = Object.keys(pages).length > 0;
  const pageCount = hasPages
    ? Object.values(pages).reduce<number>((sum, value) => sum + countPages(value), 0)
    : null;
  const missing = Array.isArray(remote.missing_business_facts)
    ? remote.missing_business_facts.map(String)
    : [];
  const warnings = [
    ...(Array.isArray(remote.warnings) ? remote.warnings.map(String) : []),
    ...missing.map(item => `Missing optional business fact: ${item}`),
  ];
  return { pages: pageCount, summary: JSON.stringify(brief, null, 2), warnings };
}
