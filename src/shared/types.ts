export type WorkflowStage =
  | 'configuration'
  | 'validation'
  | 'dry_run'
  | 'build_brief'
  | 'user_approval'
  | 'mcp_build'
  | 'monitoring'
  | 'qa'
  | 'publish_approval'
  | 'published';

export type WebsiteStatus =
  | 'draft'
  | 'validated'
  | 'dry_run_ready'
  | 'awaiting_approval'
  | 'building'
  | 'qa_review'
  | 'ready_to_publish'
  | 'published'
  | 'failed';

export type McpTransportMode = 'demo' | 'http_sse' | 'stdio';

export type QaCategory = 'seo' | 'content' | 'canonical' | 'disclosure' | 'image' | 'link';
export type QaStatus = 'pass' | 'warn' | 'fail';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type JobType = 'create_website' | 'clone_website' | 'retry_images' | 'publish_website';

export interface DryRunBrief {
  mode: McpTransportMode;
  isDemo: boolean;
  estimatedPages: number;
  estimatedImages: number;
  estimatedContentTokens: number;
  estimatedContentCostUsd: number;
  estimatedImageCostUsd: number;
  estimatedTotalCostUsd: number;
  estimatedDurationMinutes: number;
  siteArchitecture: Array<{
    path: string;
    title: string;
    purpose: string;
  }>;
  complianceNotes: string[];
  warnings: string[];
  rawMcpSummary?: string | null;
  generatedAt: string;
}

export interface QaScoreSummary {
  passed: number;
  warned: number;
  failed: number;
  total: number;
  readyToPublish: boolean;
  lastRunAt: string | null;
}

export interface WebsiteRecord {
  id: string;
  externalMcpId: string | null;
  brandName: string;
  domain: string;
  niche: string;
  locationCity: string;
  locationState: string;
  keywords: string[];
  services: string[];
  serviceAreas: string[];
  blogTopics: string[];
  blueprintId: string | null;
  workflowStage: WorkflowStage;
  status: WebsiteStatus;
  isDemo: boolean;
  dryRunBrief: DryRunBrief | null;
  qaSummary: QaScoreSummary | null;
  publishedUrl: string | null;
  disclosureText: string | null;
  engine?: string | null;
  siteType?: string | null;
  indexedPages?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildJobRecord {
  id: string;
  websiteId: string;
  websiteBrand?: string;
  websiteDomain?: string;
  jobType: JobType;
  status: JobStatus;
  progressPct: number;
  currentStep: string;
  imageFailuresCount: number;
  errorMessage: string | null;
  mcpMode: McpTransportMode;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
}

export interface QaCheckRecord {
  id: string;
  websiteId: string;
  websiteBrand?: string;
  websiteDomain?: string;
  category: QaCategory;
  checkKey: string;
  title: string;
  status: QaStatus;
  details: string;
  autoFixHint: string;
  checkedAt: string;
}

export interface BlueprintRecord {
  id: string;
  name: string;
  niche: string;
  description: string;
  defaultKeywords: string[];
  defaultServices: string[];
  defaultBlogTopics: string[];
  disclosureTemplate: string;
  promptInstructions: string;
  modelPreset: string;
  createdAt: string;
  updatedAt: string;
}

export interface CostEntryRecord {
  id: string;
  websiteId: string;
  websiteBrand?: string;
  websiteDomain?: string;
  jobId: string | null;
  category: 'content' | 'image' | 'provider_total';
  providerModel: string;
  units: number;
  unitLabel: string;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  isDemo: boolean;
  recordedAt: string;
}

export interface McpRemoteAccountInfo {
  account: string | null;
  plan: string | null;
  localAccess: string | null;
  canCreateWebsite: boolean;
  openrouterKeyConfigured: boolean;
  web3formsKeyConfigured: boolean;
  cloudflareAccounts: Array<{ id: string; label: string }>;
  remoteWebsitesCount: number | null;
  ready: boolean;
  missing: string[];
}

export interface McpSetupStatus {
  mode: McpTransportMode;
  isDemoMode: boolean;
  configured: boolean;
  connected: boolean;
  transportLabel: string;
  endpointSummary: string;
  availableTools: string[];
  missingTools: string[];
  remoteAccount?: McpRemoteAccountInfo | null;
  lastCheckedAt: string;
  message: string;
}

export interface AppSettingsPublic {
  transportMode: McpTransportMode;
  mcpEndpointUrl: string;
  mcpAuthType: 'bearer' | 'api_key' | 'none';
  hasMcpApiKey: boolean;
  maskedMcpApiKey: string;
  stdioCommand: string;
  stdioArgs: string;
  hasStdioEnv: boolean;
  contentModel: string;
  imageModel: string;
  monthlyBudgetLimitUsd: number;
  requireQaPassBeforePublish: boolean;
  updatedAt: string;
}

export interface CreateWebsiteInput {
  brandName: string;
  domain: string;
  niche: string;
  siteType?: 'city' | 'state';
  locationCity: string;
  locationState: string;
  email?: string;
  phone?: string;
  keywords: string[];
  services: string[];
  serviceAreas: string[];
  blogTopics: string[];
  blueprintId?: string | null;
  disclosureText?: string;
  testBuild?: boolean;
  noindex?: boolean;
  cloudflareAccount?: string;
}

export interface ValidationIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  complianceChecks: Array<{
    label: string;
    passed: boolean;
    detail: string;
  }>;
}

export interface OverviewData {
  mcpStatus: McpSetupStatus;
  metrics: {
    totalWebsites: number;
    publishedWebsites: number;
    buildingWebsites: number;
    failedJobs: number;
    pendingApprovalCount: number;
    qaBlockedCount: number;
    totalSpendUsd: number;
    contentSpendUsd: number;
    imageSpendUsd: number;
  };
  recentWebsites: WebsiteRecord[];
  recentJobs: BuildJobRecord[];
  costByWebsite: Array<{
    websiteId: string;
    brandName: string;
    domain: string;
    contentUsd: number;
    imageUsd: number;
    totalUsd: number;
    isDemo: boolean;
  }>;
}

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  envPasscodeManaged: boolean;
}
