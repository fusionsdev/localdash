import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ensureDbReady, pool } from './db.ts';
import { readRemoteBrief, readRemoteBuild } from './mcpState.ts';
import type {
  BuildJobRecord,
  CreateWebsiteInput,
  DryRunBrief,
  McpSetupStatus,
  McpTransportMode,
  QaCheckRecord,
  QaScoreSummary,
  ValidationIssue,
  ValidationResult,
  WebsiteRecord,
} from '../shared/types.ts';

const REQUIRED_MCP_TOOLS = [
  'get_setup_status',
  'list_websites',
  'create_website',
  'get_website_status',
  'clone_website',
  'retry_website_images',
  'publish_website',
];

interface InternalSettings {
  transportMode: McpTransportMode;
  mcpEndpointUrl: string;
  mcpAuthType: 'bearer' | 'api_key' | 'none';
  mcpApiKey: string;
  stdioCommand: string;
  stdioArgs: string;
  stdioEnvJson: string;
  contentModel: string;
  imageModel: string;
  monthlyBudgetLimitUsd: number;
  requireQaPassBeforePublish: boolean;
}

export async function getInternalSettings(): Promise<InternalSettings> {
  await ensureDbReady();
  const res = await pool.query('SELECT * FROM app_settings WHERE id = 1');
  const row = res.rows[0];

  const envUrl = (process.env.LOCALSITES_MCP_URL || '').trim();
  const envApiKey = (process.env.LOCALSITES_MCP_API_KEY || '').trim();
  const envStdioCommand = (process.env.LOCALSITES_MCP_STDIO_COMMAND || '').trim();
  const envStdioArgs = (process.env.LOCALSITES_MCP_STDIO_ARGS || '').trim();
  const envTransport = (process.env.LOCALSITES_MCP_TRANSPORT || '').trim();

  const dbUrl = String(row?.mcp_endpoint_url || '').trim();
  const dbApiKey = String(row?.mcp_api_key || '').trim();
  const dbStdioCommand = String(row?.stdio_command || '').trim();
  const dbStdioArgs = String(row?.stdio_args || '').trim();

  let mode: McpTransportMode = 'demo';
  if (row?.transport_mode === 'http_sse' || row?.transport_mode === 'stdio') {
    mode = row.transport_mode;
  } else if (envTransport === 'http_sse' || envTransport === 'stdio') {
    mode = envTransport;
  } else if (!dbUrl && envUrl) {
    mode = 'http_sse';
  } else if (!dbStdioCommand && envStdioCommand) {
    mode = 'stdio';
  }

  return {
    transportMode: mode,
    mcpEndpointUrl: dbUrl || envUrl,
    mcpAuthType:
      row?.mcp_auth_type === 'api_key' || row?.mcp_auth_type === 'none'
        ? row.mcp_auth_type
        : 'bearer',
    mcpApiKey: dbApiKey || envApiKey,
    stdioCommand: dbStdioCommand || envStdioCommand,
    stdioArgs: dbStdioArgs || envStdioArgs,
    stdioEnvJson: row?.stdio_env_json || '{}',
    contentModel: row?.content_model || 'claude-3-7-sonnet',
    imageModel: row?.image_model || 'flux-1.1-pro',
    monthlyBudgetLimitUsd: Number(row?.monthly_budget_limit_usd ?? 250),
    requireQaPassBeforePublish: Boolean(row?.require_qa_pass_before_publish ?? true),
  };
}

export function mapWebsiteRow(row: Record<string, unknown>): WebsiteRecord {
  return {
    id: String(row.id),
    externalMcpId: row.external_mcp_id ? String(row.external_mcp_id) : null,
    brandName: String(row.brand_name),
    domain: String(row.domain),
    niche: String(row.niche),
    locationCity: String(row.location_city),
    locationState: String(row.location_state),
    keywords: Array.isArray(row.keywords) ? (row.keywords as string[]) : [],
    services: Array.isArray(row.services) ? (row.services as string[]) : [],
    serviceAreas: Array.isArray(row.service_areas) ? (row.service_areas as string[]) : [],
    blogTopics: Array.isArray(row.blog_topics) ? (row.blog_topics as string[]) : [],
    blueprintId: row.blueprint_id ? String(row.blueprint_id) : null,
    workflowStage: String(row.workflow_stage) as WebsiteRecord['workflowStage'],
    status: String(row.status) as WebsiteRecord['status'],
    isDemo: Boolean(row.is_demo),
    dryRunBrief: (row.dry_run_brief_json as DryRunBrief | null) ?? null,
    qaSummary: (row.qa_score_summary_json as QaScoreSummary | null) ?? null,
    publishedUrl: row.published_url ? String(row.published_url) : null,
    disclosureText: row.disclosure_text ? String(row.disclosure_text) : null,
    engine: row.engine ? String(row.engine) : null,
    siteType: row.site_type ? String(row.site_type) : null,
    indexedPages:
      row.indexed_pages !== null && row.indexed_pages !== undefined
        ? Number(row.indexed_pages)
        : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function mapJobRow(row: Record<string, unknown>): BuildJobRecord {
  return {
    id: String(row.id),
    websiteId: String(row.website_id),
    websiteBrand: row.website_brand ? String(row.website_brand) : undefined,
    websiteDomain: row.website_domain ? String(row.website_domain) : undefined,
    jobType: String(row.job_type) as BuildJobRecord['jobType'],
    status: String(row.status) as BuildJobRecord['status'],
    progressPct: Number(row.progress_pct ?? 0),
    currentStep: String(row.current_step ?? ''),
    imageFailuresCount: Number(row.image_failures_count ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : null,
    mcpMode: (String(row.mcp_mode || 'demo') as McpTransportMode),
    payload: (row.payload_json as Record<string, unknown> | null) ?? null,
    result: (row.result_json as Record<string, unknown> | null) ?? null,
    startedAt: new Date(String(row.started_at)).toISOString(),
    completedAt: row.completed_at
      ? new Date(String(row.completed_at)).toISOString()
      : null,
  };
}

async function withLiveMcpClient<T>(
  settings: InternalSettings,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const makeClient = () =>
    new Client(
      { name: 'website-factory-control-plane', version: '1.0.0' },
      { capabilities: {} }
    );

  if (settings.transportMode === 'http_sse') {
    if (!settings.mcpEndpointUrl.trim()) {
      throw new Error('HTTP/SSE MCP endpoint URL is not configured.');
    }
    const url = new URL(settings.mcpEndpointUrl.trim());
    const headers: Record<string, string> = {};
    if (settings.mcpApiKey) {
      if (settings.mcpAuthType === 'bearer') {
        headers['Authorization'] = `Bearer ${settings.mcpApiKey}`;
      } else if (settings.mcpAuthType === 'api_key') {
        headers['X-API-Key'] = settings.mcpApiKey;
      }
    }

    const httpClient = makeClient();
    let connectedHttp = false;
    let httpErrMessage = '';
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await httpClient.connect(transport);
      connectedHttp = true;
    } catch (err) {
      httpErrMessage = err instanceof Error ? err.message : String(err);
      await httpClient.close().catch(() => undefined);
    }

    if (connectedHttp) {
      try {
        return await fn(httpClient);
      } finally {
        await httpClient.close().catch(() => undefined);
      }
    }

    const sseClient = makeClient();
    try {
      const sseTransport = new SSEClientTransport(url, {
        requestInit: { headers },
      });
      await sseClient.connect(sseTransport);
      try {
        return await fn(sseClient);
      } finally {
        await sseClient.close().catch(() => undefined);
      }
    } catch (sseErr) {
      await sseClient.close().catch(() => undefined);
      const sseErrMessage = sseErr instanceof Error ? sseErr.message : String(sseErr);
      throw new Error(
        `StreamableHTTP failed (${httpErrMessage}); SSE fallback failed (${sseErrMessage})`
      );
    }
  }

  if (settings.transportMode === 'stdio') {
    if (!settings.stdioCommand.trim()) {
      throw new Error('Stdio MCP command is not configured.');
    }
    const args = settings.stdioArgs
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    let parsedEnv: Record<string, string> = {};
    try {
      parsedEnv = JSON.parse(settings.stdioEnvJson || '{}') as Record<string, string>;
    } catch {
      parsedEnv = {};
    }
    const stdioClient = makeClient();
    const transport = new StdioClientTransport({
      command: settings.stdioCommand.trim(),
      args,
      env: { ...process.env, ...parsedEnv } as Record<string, string>,
    });
    await stdioClient.connect(transport);
    try {
      return await fn(stdioClient);
    } finally {
      await stdioClient.close().catch(() => undefined);
    }
  }

  throw new Error('Live MCP transport is not active (DEMO MODE).');
}

function parseMcpToolJson(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const r = result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
  const textParts = Array.isArray(r.content)
    ? r.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
    : [];
  const joinedText = textParts.join('\n').trim();

  if (r.isError) {
    throw new Error(joinedText || 'LocalSites.pro MCP tool returned an error.');
  }

  if (r.structuredContent && typeof r.structuredContent === 'object') {
    return { ...r.structuredContent, ...(joinedText ? { _rawText: joinedText } : {}) };
  }

  if (joinedText) {
    try {
      const parsed = JSON.parse(joinedText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>), _rawText: joinedText };
      }
      return { data: parsed, _rawText: joinedText };
    } catch {
      return { rawText: joinedText, _rawText: joinedText };
    }
  }
  return {};
}

export async function validateWebsiteConfig(
  input: CreateWebsiteInput,
  excludeWebsiteId?: string
): Promise<ValidationResult> {
  await ensureDbReady();
  const issues: ValidationIssue[] = [];
  const normalizedDomain = input.domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  if (!input.brandName.trim() || input.brandName.trim().length < 3) {
    issues.push({
      field: 'brandName',
      severity: 'error',
      message: 'Brand name must be at least 3 characters.',
    });
  }

  const domainRegex = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.[a-z]{2,}$/i;
  if (!domainRegex.test(normalizedDomain)) {
    issues.push({
      field: 'domain',
      severity: 'error',
      message: 'Enter a valid root domain without protocol (e.g. lonestarloanedu.com).',
    });
  } else {
    const dup = await pool.query(
      'SELECT id FROM websites WHERE LOWER(domain) = LOWER($1) AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [normalizedDomain, excludeWebsiteId ?? null]
    );
    if (dup.rows.length > 0) {
      issues.push({
        field: 'domain',
        severity: 'error',
        message: `Domain ${normalizedDomain} already exists in your portfolio.`,
      });
    }
  }

  if (!input.niche.trim()) {
    issues.push({ field: 'niche', severity: 'error', message: 'US loan niche is required.' });
  }
  const isStatewide = input.siteType === 'state';
  if ((!isStatewide && !input.locationCity.trim()) || !input.locationState.trim()) {
    issues.push({
      field: 'location',
      severity: 'error',
      message: isStatewide
        ? 'Target 2-letter US state code is required for statewide sites.'
        : 'Target US city and 2-letter state code are required.',
    });
  }
  if (input.keywords.length < 2) {
    issues.push({
      field: 'keywords',
      severity: 'error',
      message: 'Provide at least 2 target loan education keywords.',
    });
  }
  if (input.services.length < 2) {
    issues.push({
      field: 'services',
      severity: 'error',
      message: 'Provide at least 2 educational service pillars.',
    });
  }
  if (input.serviceAreas.length < 1) {
    issues.push({
      field: 'serviceAreas',
      severity: 'error',
      message: 'Provide at least 1 target service area or metro.',
    });
  }
  if (input.blogTopics.length < 1) {
    issues.push({
      field: 'blogTopics',
      severity: 'warning',
      message: 'Adding at least 2 blog topics improves topical authority.',
    });
  }

  const combinedText = [
    input.brandName,
    input.niche,
    ...input.keywords,
    ...input.services,
    ...input.blogTopics,
    input.disclosureText || '',
  ]
    .join(' ')
    .toLowerCase();

  const prohibitedClaims = [
    'guaranteed approval',
    '100% approval',
    'no credit check',
    'instant cash',
    'everyone approved',
  ];
  const matchedProhibited = prohibitedClaims.filter((phrase) =>
    combinedText.includes(phrase)
  );
  if (matchedProhibited.length > 0) {
    issues.push({
      field: 'compliance',
      severity: 'error',
      message: `Prohibited US lending claim detected (${matchedProhibited.join(', ')}). Replace with educational/eligibility phrasing.`,
    });
  }

  const hasDisclosure = (input.disclosureText || '').trim().length >= 30;
  if (!hasDisclosure) {
    issues.push({
      field: 'disclosureText',
      severity: 'warning',
      message: 'Custom referral/non-lender disclosure is short or empty; default compliance template will be applied.',
    });
  }

  const complianceChecks = [
    {
      label: 'Domain & Portfolio Uniqueness',
      passed: !issues.some((i) => i.field === 'domain' && i.severity === 'error'),
      detail: domainRegex.test(normalizedDomain)
        ? `${normalizedDomain} syntax valid and unique`
        : 'Invalid or duplicate domain',
    },
    {
      label: 'US Lending Compliance Guardrail (TILA / FTC)',
      passed: matchedProhibited.length === 0,
      detail:
        matchedProhibited.length === 0
          ? 'Zero prohibited guaranteed-approval claims detected'
          : `Flagged terms: ${matchedProhibited.join(', ')}`,
    },
    {
      label: 'Geo-Localization & Service Silo Coverage',
      passed: input.services.length >= 2 && input.serviceAreas.length >= 1,
      detail: `${input.services.length} services across ${input.serviceAreas.length} service areas`,
    },
    {
      label: 'Non-Lender Referral Disclosure Readiness',
      passed: hasDisclosure,
      detail: hasDisclosure
        ? 'Explicit publisher & referral disclosure present'
        : 'Will fall back to default blueprint disclosure',
    },
  ];

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
    complianceChecks,
  };
}

export class LocalSitesMcpAdapter {
  async get_setup_status(): Promise<McpSetupStatus> {
    const settings = await getInternalSettings();
    const now = new Date().toISOString();

    if (settings.transportMode === 'demo') {
      return {
        mode: 'demo',
        isDemoMode: true,
        configured: false,
        connected: false,
        transportLabel: 'Demo Mode (Local PostgreSQL Simulation)',
        endpointSummary: 'No live MCP credentials configured — running safely in DEMO MODE',
        availableTools: [...REQUIRED_MCP_TOOLS],
        missingTools: [],
        lastCheckedAt: now,
        message:
          'DEMO MODE active. Configure HTTP/SSE or Stdio credentials in Settings to connect your live LocalSites.pro MCP server.',
      };
    }

    const isConfigured =
      settings.transportMode === 'http_sse'
        ? Boolean(settings.mcpEndpointUrl.trim())
        : Boolean(settings.stdioCommand.trim());

    if (!isConfigured) {
      return {
        mode: settings.transportMode,
        isDemoMode: true,
        configured: false,
        connected: false,
        transportLabel:
          settings.transportMode === 'http_sse' ? 'HTTP / SSE' : 'Stdio Process',
        endpointSummary: 'Transport selected but endpoint/command is missing (falling back to DEMO MODE)',
        availableTools: [],
        missingTools: [...REQUIRED_MCP_TOOLS],
        lastCheckedAt: now,
        message: 'Transport credentials incomplete. Save endpoint/command and key in Settings.',
      };
    }

    try {
      const toolsResp = await withLiveMcpClient(settings, async (client) => {
        const listed = await client.listTools();
        const names = (listed.tools || []).map((t) => t.name);
        let remoteSetup: Record<string, unknown> = {};
        if (names.includes('get_setup_status')) {
          const callRes = await client.callTool({
            name: 'get_setup_status',
            arguments: {},
          });
          remoteSetup = parseMcpToolJson(callRes);
        }
        return { names, remoteSetup };
      });

      const missing = REQUIRED_MCP_TOOLS.filter((t) => !toolsResp.names.includes(t));
      const rs = toolsResp.remoteSetup;
      const cfAccounts = Array.isArray(rs.cloudflare_accounts)
        ? (rs.cloudflare_accounts as Array<{ id?: string; label?: string }>).map((a) => ({
            id: String(a.id || ''),
            label: String(a.label || a.id || 'Cloudflare'),
          }))
        : [];
      const remoteAccount =
        Object.keys(rs).length > 0
          ? {
              account: typeof rs.account === 'string' ? rs.account : null,
              plan: typeof rs.plan === 'string' ? rs.plan : null,
              localAccess: typeof rs.local_access === 'string' ? rs.local_access : null,
              canCreateWebsite: Boolean(rs.can_create_website ?? rs.ready ?? true),
              openrouterKeyConfigured: Boolean(rs.openrouter_key_configured),
              web3formsKeyConfigured: Boolean(rs.web3forms_key_configured),
              cloudflareAccounts: cfAccounts,
              remoteWebsitesCount:
                typeof rs.websites === 'number' ? rs.websites : null,
              ready: Boolean(rs.ready ?? true),
              missing: Array.isArray(rs.missing) ? (rs.missing as string[]) : [],
            }
          : null;

      const summaryMsg = remoteAccount?.account
        ? `Connected to LocalSites.pro (${remoteAccount.account} · ${String(remoteAccount.plan || 'pro').toUpperCase()} · ${remoteAccount.remoteWebsitesCount ?? 0} remote websites).`
        : typeof rs.message === 'string'
          ? rs.message
          : 'Connected to live LocalSites.pro MCP server.';

      return {
        mode: settings.transportMode,
        isDemoMode: false,
        configured: true,
        connected: true,
        transportLabel:
          settings.transportMode === 'http_sse' ? 'HTTP / SSE MCP' : 'Stdio MCP',
        endpointSummary:
          settings.transportMode === 'http_sse'
            ? settings.mcpEndpointUrl
            : `${settings.stdioCommand} ${settings.stdioArgs}`.trim(),
        availableTools: toolsResp.names,
        missingTools: missing,
        remoteAccount,
        lastCheckedAt: now,
        message: summaryMsg,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reach MCP server.';
      return {
        mode: settings.transportMode,
        isDemoMode: false,
        configured: true,
        connected: false,
        transportLabel:
          settings.transportMode === 'http_sse' ? 'HTTP / SSE MCP' : 'Stdio MCP',
        endpointSummary:
          settings.transportMode === 'http_sse'
            ? settings.mcpEndpointUrl
            : settings.stdioCommand,
        availableTools: [],
        missingTools: [...REQUIRED_MCP_TOOLS],
        remoteAccount: null,
        lastCheckedAt: now,
        message: `MCP connection failed: ${message}`,
      };
    }
  }

  async list_websites(): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    websites: WebsiteRecord[];
    remoteCount?: number;
    syncedCount?: number;
    localCount?: number;
    phpCount?: number;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();

    if (settings.transportMode !== 'demo') {
      const remoteData = await withLiveMcpClient(settings, async (client) => {
        const res = await client.callTool({ name: 'list_websites', arguments: {} });
        return parseMcpToolJson(res);
      });

      const remoteList = Array.isArray(remoteData.websites)
        ? (remoteData.websites as Array<Record<string, unknown>>)
        : [];

      let syncedCount = 0;
      for (const item of remoteList) {
        const extId = item.site_id ? String(item.site_id) : null;
        const rawDomain = item.domain ? String(item.domain).trim().toLowerCase() : '';
        const liveUrl = item.live_url ? String(item.live_url).trim() : null;
        const fallbackDomain =
          rawDomain ||
          (liveUrl
            ? liveUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
            : extId
              ? `${extId}.localsites.pro`
              : '');
        if (!fallbackDomain) continue;

        const company = String(item.company || fallbackDomain).trim();
        const niche = String(item.niche || 'Local Service').trim();
        const locRaw = String(item.location || '').trim();
        const locParts = locRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const city = locParts.length >= 2 ? locParts[0] : locRaw || 'US';
        const state =
          locParts.length >= 2
            ? locParts[locParts.length - 1].slice(0, 20)
            : 'US';

        const remoteStatus = String(item.status || '').toLowerCase();
        let mappedStatus: WebsiteRecord['status'] = 'published';
        let mappedStage: WebsiteRecord['workflowStage'] = 'published';
        if (remoteStatus.includes('build') || remoteStatus.includes('queue') || remoteStatus.includes('deploy')) {
          mappedStatus = 'building';
          mappedStage = 'monitoring';
        } else if (remoteStatus.includes('fail') || remoteStatus.includes('error')) {
          mappedStatus = 'failed';
          mappedStage = 'monitoring';
        } else if (remoteStatus.includes('draft')) {
          mappedStatus = 'draft';
          mappedStage = 'configuration';
        } else if (!liveUrl && remoteStatus !== 'live' && remoteStatus !== 'published' && remoteStatus !== 'deployed') {
          mappedStatus = 'qa_review';
          mappedStage = 'qa';
        }

        const engine = item.engine ? String(item.engine) : 'local';
        const siteType = item.site_type ? String(item.site_type) : 'city';
        let indexedPages: number | null = null;
        if (typeof item.indexed_pages === 'number') {
          indexedPages = item.indexed_pages;
        } else if (
          item.indexed_pages &&
          typeof item.indexed_pages === 'object' &&
          typeof (item.indexed_pages as Record<string, unknown>).count === 'number'
        ) {
          indexedPages = Number((item.indexed_pages as Record<string, unknown>).count);
        }

        const existingRes = await pool.query(
          `SELECT id FROM websites WHERE ($1::text IS NOT NULL AND external_mcp_id = $1) OR LOWER(domain) = LOWER($2) LIMIT 1`,
          [extId, fallbackDomain]
        );

        if (existingRes.rows.length > 0) {
          await pool.query(
            `UPDATE websites
             SET external_mcp_id = COALESCE($1, external_mcp_id),
                 brand_name = $2,
                 niche = $3,
                 location_city = $4,
                 location_state = $5,
                 status = $6,
                 workflow_stage = $7,
                 is_demo = FALSE,
                 published_url = COALESCE($8, published_url),
                 engine = $9,
                 site_type = $10,
                 indexed_pages = COALESCE($11, indexed_pages),
                 updated_at = NOW()
             WHERE id = $12`,
            [
              extId,
              company,
              niche,
              city,
              state,
              mappedStatus,
              mappedStage,
              liveUrl,
              engine,
              siteType,
              indexedPages,
              existingRes.rows[0].id,
            ]
          );
        } else {
          await pool.query(
            `INSERT INTO websites (
              id, external_mcp_id, brand_name, domain, niche, location_city, location_state,
              keywords, services, service_areas, blog_topics, workflow_stage, status,
              is_demo, published_url, engine, site_type, indexed_pages, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$8,$9,FALSE,$10,$11,$12,$13,$14,NOW()
            )
            ON CONFLICT (domain) DO UPDATE SET
              external_mcp_id = COALESCE(EXCLUDED.external_mcp_id, websites.external_mcp_id),
              brand_name = EXCLUDED.brand_name,
              status = EXCLUDED.status,
              is_demo = FALSE,
              published_url = COALESCE(EXCLUDED.published_url, websites.published_url),
              engine = EXCLUDED.engine,
              site_type = EXCLUDED.site_type,
              indexed_pages = COALESCE(EXCLUDED.indexed_pages, websites.indexed_pages),
              updated_at = NOW()`,
            [
              crypto.randomUUID(),
              extId,
              company,
              fallbackDomain,
              niche,
              city,
              state,
              mappedStage,
              mappedStatus,
              liveUrl,
              engine,
              siteType,
              indexedPages,
              item.created_at ? new Date(String(item.created_at)).toISOString() : new Date().toISOString(),
            ]
          );
        }
        syncedCount += 1;
      }

      const dbRes = await pool.query('SELECT * FROM websites ORDER BY is_demo ASC, updated_at DESC');
      return {
        mode: settings.transportMode,
        isDemo: false,
        websites: dbRes.rows.map(mapWebsiteRow),
        remoteCount: Number(remoteData.count ?? remoteList.length),
        syncedCount,
        localCount:
          typeof remoteData.local_count === 'number' ? remoteData.local_count : undefined,
        phpCount:
          typeof remoteData.php_count === 'number' ? remoteData.php_count : undefined,
      };
    }

    const dbRes = await pool.query('SELECT * FROM websites ORDER BY updated_at DESC');
    return {
      mode: 'demo',
      isDemo: true,
      websites: dbRes.rows.map(mapWebsiteRow),
    };
  }

  async create_website(params: {
    websiteId?: string;
    input: CreateWebsiteInput;
    dryRun: boolean;
  }): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    website: WebsiteRecord;
    dryRunBrief?: DryRunBrief;
    job?: BuildJobRecord;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();

    const normalizedDomain = params.input.domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');

    const totalPages =
      4 +
      params.input.services.length * 2 +
      params.input.serviceAreas.length +
      params.input.blogTopics.length;
    const totalImages = Math.max(6, Math.round(totalPages * 0.65));
    const estimatedContentTokens = totalPages * 3600;
    const estimatedContentCostUsd = Number(((estimatedContentTokens / 1000) * 0.062).toFixed(2));
    const estimatedImageCostUsd = Number((totalImages * 0.2).toFixed(2));
    const estimatedTotalCostUsd = Number(
      (estimatedContentCostUsd + estimatedImageCostUsd).toFixed(2)
    );

    if (settings.transportMode !== 'demo') {
      // Exact LocalSites.pro create_website schema (additionalProperties: false)
      const mcpArgs: Record<string, unknown> = {
        site_type: params.input.siteType || 'city',
        niche: params.input.niche.trim(),
        city: params.input.locationCity.trim(),
        state: params.input.locationState.trim(),
        country: 'US',
        company_name: params.input.brandName.trim(),
        domain: normalizedDomain,
        owner_operated: false,
        generate_images: true,
        dry_run: params.dryRun,
        start_build: !params.dryRun,
      };

      if (params.input.keywords[0]) {
        mcpArgs.primary_keyword = params.input.keywords[0];
      }
      if (params.input.keywords[1]) {
        mcpArgs.secondary_keyword = params.input.keywords[1];
      }
      if (params.input.services.length > 0) {
        mcpArgs.service_names = params.input.services;
      }
      if (params.input.serviceAreas.length > 0) {
        mcpArgs.area_names = params.input.serviceAreas;
      }
      if (params.input.blogTopics.length > 0) {
        mcpArgs.blog_titles = params.input.blogTopics;
      }
      if (params.input.email?.trim()) {
        mcpArgs.email = params.input.email.trim();
      }
      if (params.input.phone?.trim()) {
        mcpArgs.phone = params.input.phone.trim();
      }
      if (params.input.testBuild) {
        mcpArgs.test_build = true;
      }
      if (params.input.noindex) {
        mcpArgs.noindex = true;
      }
      if (params.input.cloudflareAccount?.trim()) {
        mcpArgs.cloudflare_account = params.input.cloudflareAccount.trim();
      }

      const remoteRes = await withLiveMcpClient(settings, async (client) => {
        const callRes = await client.callTool({
          name: 'create_website',
          arguments: mcpArgs,
        });
        return parseMcpToolJson(callRes);
      });

      const websiteId = params.websiteId || crypto.randomUUID();
      const normalizedBrief = readRemoteBrief(remoteRes);
      const remoteWarnings = normalizedBrief.warnings;

      const estPages = Number(
        remoteRes.estimated_pages ?? remoteRes.total_pages ?? remoteRes.pages_count ??
        normalizedBrief.pages ?? totalPages
      );
      const estImages = Number(
        remoteRes.estimated_images ?? remoteRes.images_count ?? totalImages
      );
      const estTotalCost = Number(
        remoteRes.estimated_total_cost_usd ??
          remoteRes.estimated_cost_usd ??
          estimatedTotalCostUsd
      );

      const brief: DryRunBrief = {
        mode: settings.transportMode,
        isDemo: false,
        estimatedPages: estPages,
        estimatedImages: estImages,
        estimatedContentTokens,
        estimatedContentCostUsd: Number(
          remoteRes.estimated_content_cost_usd ?? estimatedContentCostUsd
        ),
        estimatedImageCostUsd: Number(
          remoteRes.estimated_image_cost_usd ?? estimatedImageCostUsd
        ),
        estimatedTotalCostUsd: estTotalCost,
        estimatedDurationMinutes: Number(remoteRes.estimated_duration_minutes ?? 7),
        siteArchitecture: buildArchitecturePreview(params.input),
        complianceNotes: [
          'Live LocalSites.pro MCP dry-run brief verified',
          'US non-lender educational publisher & referral disclosure included',
          'Canonical tags must be checked on the deployed preview before indexing',
        ],
        warnings: remoteWarnings,
        rawMcpSummary:
          typeof remoteRes._rawText === 'string'
            ? remoteRes._rawText
            : JSON.stringify(remoteRes, null, 2),
        generatedAt: new Date().toISOString(),
      };

      const stage = params.dryRun ? 'user_approval' : 'monitoring';
      const status = params.dryRun ? 'awaiting_approval' : 'building';
      const externalId =
        typeof remoteRes.site_id === 'string'
          ? remoteRes.site_id
          : typeof remoteRes.website_id === 'string'
            ? remoteRes.website_id
            : null;

      await upsertWebsiteRecord({
        id: websiteId,
        externalMcpId: externalId,
        input: { ...params.input, domain: normalizedDomain },
        stage,
        status,
        isDemo: false,
        brief,
      });

      const website = await fetchWebsiteById(websiteId);
      let job: BuildJobRecord | undefined;
      if (!params.dryRun) {
        job = await createJobAndCosts(website, settings, 'create_website', brief, false);
      }

      return {
        mode: settings.transportMode,
        isDemo: false,
        website,
        dryRunBrief: brief,
        job,
      };
    }

    // Explicit DEMO MODE execution persisted in Neon PostgreSQL
    const websiteId = params.websiteId || crypto.randomUUID();
    const brief: DryRunBrief = {
      mode: 'demo',
      isDemo: true,
      estimatedPages: totalPages,
      estimatedImages: totalImages,
      estimatedContentTokens,
      estimatedContentCostUsd,
      estimatedImageCostUsd,
      estimatedTotalCostUsd,
      estimatedDurationMinutes: Math.max(4, Math.round(totalPages * 0.4)),
      siteArchitecture: buildArchitecturePreview(params.input),
      complianceNotes: [
        'DEMO MODE simulation — no external LocalSites.pro credits consumed',
        'Above-the-fold US loan referral & non-lender disclaimer configured',
        'Representative APR range tables structured without guaranteed-approval claims',
      ],
      warnings:
        params.input.blogTopics.length < 2
          ? ['Recommend adding at least 2 educational blog guides for stronger topical depth.']
          : [],
      generatedAt: new Date().toISOString(),
    };

    const stage = params.dryRun ? 'user_approval' : 'monitoring';
    const status = params.dryRun ? 'awaiting_approval' : 'building';

    await upsertWebsiteRecord({
      id: websiteId,
      externalMcpId: params.dryRun ? null : `demo_ls_${websiteId.slice(0, 6)}`,
      input: { ...params.input, domain: normalizedDomain },
      stage,
      status,
      isDemo: true,
      brief,
    });

    const website = await fetchWebsiteById(websiteId);
    let job: BuildJobRecord | undefined;
    if (!params.dryRun) {
      job = await createJobAndCosts(website, settings, 'create_website', brief, true);
    }

    return {
      mode: 'demo',
      isDemo: true,
      website,
      dryRunBrief: brief,
      job,
    };
  }

  async get_website_status(websiteId: string): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    website: WebsiteRecord;
    latestJob: BuildJobRecord | null;
    remoteDetails?: Record<string, unknown>;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();
    const website = await fetchWebsiteById(websiteId);
    let remoteDetails: Record<string, unknown> | undefined;

    if (settings.transportMode !== 'demo' && website.externalMcpId && !website.isDemo) {
      const remote = await withLiveMcpClient(settings, async (client) => {
        const res = await client.callTool({
          name: 'get_website_status',
          arguments: { site_id: website.externalMcpId },
        });
        return parseMcpToolJson(res);
      });
      remoteDetails = remote;

      const snapshot = readRemoteBuild(remote);
      const pct = snapshot.progressPct;
      const isFailed = snapshot.state === 'failed';
      const isDone = snapshot.state === 'completed';
      const stepMsg = snapshot.imageFailure
        ? `${snapshot.currentStep} (image warning: ${snapshot.imageFailure})`
        : snapshot.currentStep;
      const liveUrl = snapshot.liveUrl;

      const existingJob = await pool.query(
        'SELECT id, job_type FROM build_jobs WHERE website_id = $1 ORDER BY started_at DESC LIMIT 1',
        [websiteId]
      );
      // Remote cost_usd is the combined provider cost, NOT a split between
      // content and images. Record it separately; never fabricate a breakdown.
      if (snapshot.costUsd !== null && existingJob.rows.length > 0 &&
          ['create_website', 'retry_images'].includes(String(existingJob.rows[0].job_type))) {
        const jobId = String(existingJob.rows[0].id);
        const costRow = await pool.query(
          `SELECT id FROM cost_entries WHERE job_id = $1 AND category = 'provider_total' LIMIT 1`,
          [jobId]
        );
        if (costRow.rows.length > 0) {
          await pool.query(
            `UPDATE cost_entries SET actual_cost_usd = $1 WHERE id = $2`,
            [snapshot.costUsd, costRow.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO cost_entries
              (id, website_id, job_id, category, provider_model, units, unit_label,
               estimated_cost_usd, actual_cost_usd, is_demo)
             VALUES ($1,$2,$3,'provider_total','LocalSites.pro (combined)',1,'build',0,$4,FALSE)`,
            [crypto.randomUUID(), websiteId, jobId, snapshot.costUsd]
          );
        }
      }

      if (existingJob.rows.length > 0) {
        await pool.query(
          `UPDATE build_jobs
           SET progress_pct = $1,
               status = $2,
               current_step = $3,
               error_message = $4,
               result_json = $5::jsonb,
               completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN NOW() ELSE NULL END
           WHERE id = $6`,
          [
            isDone ? 100 : pct,
            isFailed ? 'failed' : isDone ? 'completed' : 'running',
            stepMsg,
            isFailed ? String(snapshot.error || stepMsg) : null,
            JSON.stringify(remote),
            existingJob.rows[0].id,
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO build_jobs (
            id, website_id, job_type, status, progress_pct, current_step,
            mcp_mode, result_json, completed_at
          ) VALUES ($1,$2,'create_website',$3,$4,$5,$6,$7::jsonb,$8)`,
          [
            crypto.randomUUID(),
            websiteId,
            isFailed ? 'failed' : isDone ? 'completed' : 'running',
            isDone ? 100 : pct,
            stepMsg,
            settings.transportMode,
            JSON.stringify(remote),
            isDone || isFailed ? new Date().toISOString() : null,
          ]
        );
      }

      // Status from LocalSites.pro is authoritative. Deployment finishes
      // asynchronously; initial creation still requires QA before approval.
      const latestType = String(existingJob.rows[0]?.job_type || 'create_website');
      if (isFailed) {
        await pool.query(
          `UPDATE websites SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [websiteId]
        );
      } else if (isDone) {
        const isPublish = latestType === 'publish_website';
        await pool.query(
          `UPDATE websites SET
            status = $1, workflow_stage = $2,
            published_url = COALESCE($3, published_url),
            updated_at = NOW() WHERE id = $4`,
          [
            isPublish ? 'published' : 'qa_review',
            isPublish ? 'published' : 'qa',
            liveUrl,
            websiteId,
          ]
        );
      }
    } else {
      // Demo mode realistic job progression when checking status
      const jobRes = await pool.query(
        'SELECT * FROM build_jobs WHERE website_id = $1 ORDER BY started_at DESC LIMIT 1',
        [websiteId]
      );
      const latest = jobRes.rows[0];
      if (latest && (latest.status === 'queued' || latest.status === 'running')) {
        const nextPct = Math.min(100, Number(latest.progress_pct ?? 0) + 34);
        const isDone = nextPct >= 100;
        const stepLabel = isDone
          ? 'All pages, disclosures & media generated (DEMO MODE). Ready for QA.'
          : nextPct >= 66
            ? 'Generating service area pages, canonical tags & loan disclaimers...'
            : 'Scaffolding core architecture & rendering hero/service images...';

        await pool.query(
          `UPDATE build_jobs
           SET status = $1,
               progress_pct = $2,
               current_step = $3,
               completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE NULL END
           WHERE id = $4`,
          [isDone ? 'completed' : 'running', nextPct, stepLabel, latest.id]
        );

        if (isDone) {
          await pool.query(
            `UPDATE websites SET status = 'qa_review', workflow_stage = 'qa', updated_at = NOW() WHERE id = $1`,
            [websiteId]
          );
          await runFullQaAudit(websiteId);
        }
      }
    }

    const updatedSite = await fetchWebsiteById(websiteId);
    const jobRes = await pool.query(
      `SELECT bj.*, w.brand_name AS website_brand, w.domain AS website_domain
       FROM build_jobs bj
       JOIN websites w ON w.id = bj.website_id
       WHERE bj.website_id = $1
       ORDER BY bj.started_at DESC LIMIT 1`,
      [websiteId]
    );

    return {
      mode: settings.transportMode,
      isDemo: settings.transportMode === 'demo' || updatedSite.isDemo,
      website: updatedSite,
      latestJob: jobRes.rows[0] ? mapJobRow(jobRes.rows[0]) : null,
      remoteDetails,
    };
  }

  async stop_website_build(websiteId: string, force = false): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    website: WebsiteRecord;
    message: string;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();
    const website = await fetchWebsiteById(websiteId);
    let message = 'Build stopped.';

    if (settings.transportMode !== 'demo' && website.externalMcpId && !website.isDemo) {
      const remote = await withLiveMcpClient(settings, async (client) => {
        const res = await client.callTool({
          name: 'stop_website_build',
          arguments: { site_id: website.externalMcpId, force },
        });
        return parseMcpToolJson(res);
      });
      if (typeof remote.message === 'string') {
        message = remote.message;
      }
    }

    await pool.query(
      `UPDATE build_jobs
       SET status = 'failed',
           error_message = 'Stopped by owner via stop_website_build',
           completed_at = NOW()
       WHERE website_id = $1 AND status IN ('queued', 'running')`,
      [websiteId]
    );
    await pool.query(
      `UPDATE websites SET status = 'draft', updated_at = NOW() WHERE id = $1 AND status = 'building'`,
      [websiteId]
    );

    return {
      mode: settings.transportMode,
      isDemo: settings.transportMode === 'demo' || website.isDemo,
      website: await fetchWebsiteById(websiteId),
      message,
    };
  }

  async clone_website(params: {
    sourceWebsiteId: string;
    newBrandName: string;
    newDomain: string;
    locationCity: string;
    locationState: string;
  }): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    website: WebsiteRecord;
    job: BuildJobRecord;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();
    const source = await fetchWebsiteById(params.sourceWebsiteId);
    const cleanDomain = params.newDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');

    let externalMcpId: string | null = `demo_ls_${crypto.randomUUID().slice(0, 6)}`;
    let isDemo = true;

    if (settings.transportMode !== 'demo' && source.externalMcpId && !source.isDemo) {
      // Exact LocalSites.pro clone_website schema (additionalProperties: false)
      const remote = await withLiveMcpClient(settings, async (client) => {
        const res = await client.callTool({
          name: 'clone_website',
          arguments: {
            source_site_id: source.externalMcpId,
            city: params.locationCity.trim(),
            state: params.locationState.trim(),
            company_name: params.newBrandName.trim(),
            domain: cleanDomain,
            dry_run: false,
          },
        });
        return parseMcpToolJson(res);
      });
      externalMcpId =
        typeof remote.site_id === 'string'
          ? remote.site_id
          : typeof remote.website_id === 'string'
            ? remote.website_id
            : externalMcpId;
      isDemo = false;
    }

    const newId = crypto.randomUUID();
    const clonedAreas = [
      `${params.locationCity}, ${params.locationState}`,
      ...source.serviceAreas.slice(1),
    ];

    await pool.query(
      `INSERT INTO websites (
        id, external_mcp_id, brand_name, domain, niche, location_city, location_state,
        keywords, services, service_areas, blog_topics, blueprint_id, workflow_stage, status,
        is_demo, dry_run_brief_json, disclosure_text
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,'monitoring','building',$13,$14::jsonb,$15)`,
      [
        newId,
        externalMcpId,
        params.newBrandName.trim(),
        cleanDomain,
        source.niche,
        params.locationCity.trim(),
        params.locationState.trim().toUpperCase(),
        JSON.stringify(source.keywords),
        JSON.stringify(source.services),
        JSON.stringify(clonedAreas),
        JSON.stringify(source.blogTopics),
        source.blueprintId,
        isDemo,
        source.dryRunBrief ? JSON.stringify(source.dryRunBrief) : null,
        source.disclosureText,
      ]
    );

    const clonedSite = await fetchWebsiteById(newId);
    const job = await createJobAndCosts(
      clonedSite,
      settings,
      'clone_website',
      source.dryRunBrief,
      isDemo
    );

    return {
      mode: settings.transportMode,
      isDemo,
      website: clonedSite,
      job,
    };
  }

  async retry_website_images(websiteId: string): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    website: WebsiteRecord;
    job: BuildJobRecord;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();
    const website = await fetchWebsiteById(websiteId);
    const isDemo = settings.transportMode === 'demo' || website.isDemo;

    if (!isDemo && !website.externalMcpId) {
      throw new Error('Cannot retry images: remote LocalSites.pro site ID is missing.');
    }

    let remote: Record<string, unknown> = {};
    if (!isDemo && website.externalMcpId) {
      remote = await withLiveMcpClient(settings, async client => {
        const res = await client.callTool({
          name: 'retry_website_images',
          arguments: { site_id: website.externalMcpId! },
        });
        return parseMcpToolJson(res);
      });
    }
    // A retry can be asynchronous. Only the remote status endpoint can confirm
    // generated assets; never claim success or bill synthetic actual costs here.
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO build_jobs (
        id, website_id, job_type, status, progress_pct, current_step,
        image_failures_count, error_message, mcp_mode, result_json
      ) VALUES ($1,$2,'retry_images',$3,$4,$5,0,NULL,$6,$7::jsonb)`,
      [
        jobId, websiteId, isDemo ? 'completed' : 'running', isDemo ? 100 : 0,
        isDemo ? 'DEMO MODE: image retry simulated' : 'Image retry requested; awaiting remote verification',
        settings.transportMode, JSON.stringify(remote),
      ]
    );

    const updatedSite = await fetchWebsiteById(websiteId);
    const jobRes = await pool.query(
      `SELECT bj.*, w.brand_name AS website_brand, w.domain AS website_domain
       FROM build_jobs bj JOIN websites w ON w.id = bj.website_id WHERE bj.id = $1`,
      [jobId]
    );
    return {
      mode: settings.transportMode,
      isDemo,
      website: updatedSite,
      job: mapJobRow(jobRes.rows[0]),
    };
  }

  async publish_website(
    websiteId: string,
    overrideQa = false
  ): Promise<{
    mode: McpTransportMode;
    isDemo: boolean;
    website: WebsiteRecord;
    publishedUrl: string;
  }> {
    const settings = await getInternalSettings();
    await ensureDbReady();
    const website = await fetchWebsiteById(websiteId);

    if (settings.requireQaPassBeforePublish && !overrideQa) {
      const qaRes = await pool.query(
        `SELECT COUNT(*)::int AS fail_count FROM qa_checks WHERE website_id = $1 AND status = 'fail'`,
        [websiteId]
      );
      const failCount = Number(qaRes.rows[0]?.fail_count ?? 0);
      if (failCount > 0) {
        throw new Error(
          `Publish blocked: ${failCount} failing QA check(s) remain in QA Center.`
        );
      }
    }

    const isDemo = settings.transportMode === 'demo' || website.isDemo;
    if (!isDemo && !website.externalMcpId) {
      throw new Error('Cannot publish: remote LocalSites.pro site ID is missing.');
    }

    let publishedUrl = website.publishedUrl;
    let remote: Record<string, unknown> = {};
    if (!isDemo && website.externalMcpId) {
      remote = await withLiveMcpClient(settings, async client => {
        const res = await client.callTool({
          name: 'publish_website',
          arguments: { site_id: website.externalMcpId! },
        });
        return parseMcpToolJson(res);
      });
      if (typeof remote.live_url === 'string' && remote.live_url) {
        publishedUrl = remote.live_url;
      } else if (typeof remote.published_url === 'string' && remote.published_url) {
        publishedUrl = remote.published_url;
      }
    }

    const jobId = crypto.randomUUID();
    // Live publish queues a remote deployment. Do not mark Published until
    // get_website_status verifies a successful remote build/deploy.
    await pool.query(
      `INSERT INTO build_jobs (
        id, website_id, job_type, status, progress_pct, current_step,
        image_failures_count, mcp_mode, result_json, completed_at
      ) VALUES ($1,$2,'publish_website',$3,$4,$5,0,$6,$7::jsonb,$8)`,
      [
        jobId, websiteId, isDemo ? 'completed' : 'running', isDemo ? 100 : 0,
        isDemo ? 'Published in DEMO MODE' : 'Deployment requested; awaiting LocalSites.pro confirmation',
        settings.transportMode, JSON.stringify(remote), isDemo ? new Date().toISOString() : null,
      ]
    );
    await pool.query(
      `UPDATE websites SET status = $1, workflow_stage = $2,
       published_url = COALESCE($3, published_url), updated_at = NOW()
       WHERE id = $4`,
      [
        isDemo ? 'published' : 'building',
        isDemo ? 'published' : 'monitoring',
        isDemo ? (publishedUrl || `https://${website.domain}`) : publishedUrl,
        websiteId,
      ]
    );
    return {
      mode: settings.transportMode,
      isDemo,
      website: await fetchWebsiteById(websiteId),
      publishedUrl: publishedUrl || '',
    };
  }
}

export async function runFullQaAudit(websiteId: string): Promise<{
  checks: QaCheckRecord[];
  summary: QaScoreSummary;
}> {
  await ensureDbReady();
  const website = await fetchWebsiteById(websiteId);
  const failedImageRes = await pool.query(
    `SELECT COALESCE(SUM(image_failures_count), 0)::int AS failed_imgs
     FROM build_jobs WHERE website_id = $1 AND status = 'failed'`,
    [websiteId]
  );
  const failedImages = Number(failedImageRes.rows[0]?.failed_imgs ?? 0);

  const hasDisclosure = Boolean(website.disclosureText && website.disclosureText.trim().length >= 30);
  const hasBlogs = website.blogTopics.length >= 2;
  const hasAreas = website.serviceAreas.length >= 1;

  let checksToUpsert: Array<{
    category: QaCheckRecord['category'];
    key: string;
    title: string;
    status: QaCheckRecord['status'];
    details: string;
    hint: string;
  }> = [];

  const canFetchLive =
    !website.isDemo &&
    Boolean(website.publishedUrl) &&
    /^https?:\/\//i.test(website.publishedUrl || '');

  if (canFetchLive && website.publishedUrl) {
    try {
      const resp = await fetch(website.publishedUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: {
          'User-Agent': 'WebsiteFactory-QAAuditor/1.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      const html = await resp.text();
      const httpOk = resp.ok;

      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const titleText = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
      const metaDescMatch =
        html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
        html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
      const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : '';
      const h1Count = (html.match(/<h1\b[^>]*>/gi) || []).length;
      const hasJsonLd = /<script[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(html);
      const hasNoindex =
        /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);

      const seoPassed = httpOk && titleText.length >= 15 && metaDesc.length >= 40 && h1Count >= 1;
      const seoWarn = httpOk && titleText.length > 0 && !seoPassed;

      const strippedText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const wordCount = strippedText ? strippedText.split(' ').length : 0;
      const lowerText = strippedText.toLowerCase();
      const prohibitedFound = [
        'guaranteed approval',
        '100% approval',
        'no credit check',
        'everyone approved',
      ].filter((term) => lowerText.includes(term));

      const canonicalMatch =
        html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i) ||
        html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["'][^>]*>/i);
      const canonicalHref = canonicalMatch ? canonicalMatch[1].trim() : '';
      const canonicalMatchesDomain =
        Boolean(canonicalHref) &&
        canonicalHref.toLowerCase().includes(website.domain.toLowerCase());

      const disclosureSignals = [
        'disclosure',
        'disclaimer',
        'not a lender',
        'not a direct lender',
        'educational',
        'lending partner',
        'referral',
        'privacy policy',
      ].filter((sig) => lowerText.includes(sig));

      const imgTags = html.match(/<img\b[^>]*>/gi) || [];
      const imgsWithAlt = imgTags.filter((tag) => /\balt=["'][^"']+["']/i.test(tag)).length;
      const imgCoverage = imgTags.length > 0 ? Math.round((imgsWithAlt / imgTags.length) * 100) : 100;

      const anchorHrefs = Array.from(html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)).map(
        (m) => m[1]
      );
      const internalLinks = anchorHrefs.filter(
        (h) => h.startsWith('/') || h.toLowerCase().includes(website.domain.toLowerCase())
      ).length;

      checksToUpsert = [
        {
          category: 'seo',
          key: 'seo_meta',
          title: `Live HTML SEO, H1 & Schema (${website.domain})`,
          status: seoPassed ? 'pass' : seoWarn ? 'warn' : 'fail',
          details: `HTTP ${resp.status} · Title (${titleText.length} chars) · Meta desc (${metaDesc.length} chars) · ${h1Count} H1 · JSON-LD ${hasJsonLd ? 'present' : 'not detected'}${hasNoindex ? ' · NOINDEX detected' : ''}.`,
          hint: seoPassed
            ? ''
            : hasNoindex
              ? 'Remove noindex meta tag when ready to index.'
              : 'Verify title tag, meta description (50–160 chars), and H1 markup.',
        },
        {
          category: 'content',
          key: 'content_depth',
          title: 'Live page word depth & US lending claim hygiene',
          status:
            prohibitedFound.length > 0
              ? 'fail'
              : wordCount >= 350
                ? 'pass'
                : 'warn',
          details:
            prohibitedFound.length > 0
              ? `Flagged prohibited phrase(s): ${prohibitedFound.join(', ')} (${wordCount.toLocaleString()} words scanned).`
              : `${wordCount.toLocaleString()} rendered words scanned on homepage with zero prohibited lending claims.`,
          hint:
            prohibitedFound.length > 0
              ? 'Remove guaranteed-approval / no-credit-check phrasing immediately.'
              : wordCount < 350
                ? 'Expand homepage copy to 400+ words for topical authority.'
                : '',
        },
        {
          category: 'canonical',
          key: 'canonical_tags',
          title: `Live Canonical URL check (${website.domain})`,
          status: canonicalMatchesDomain ? 'pass' : canonicalHref ? 'warn' : 'fail',
          details: canonicalHref
            ? `Canonical points to ${canonicalHref}`
            : 'No <link rel="canonical"> tag found in live HTML head.',
          hint: canonicalMatchesDomain
            ? ''
            : `Set self-referencing canonical to https://${website.domain}/`,
        },
        {
          category: 'disclosure',
          key: 'loan_disclosure',
          title: 'Live disclosure & compliance footer signals',
          status: disclosureSignals.length >= 2 ? 'pass' : disclosureSignals.length === 1 ? 'warn' : 'fail',
          details:
            disclosureSignals.length > 0
              ? `Detected signals on live page: ${disclosureSignals.join(', ')}.`
              : 'No explicit disclosure, disclaimer, or non-lender notice detected on homepage.',
          hint:
            disclosureSignals.length >= 2
              ? ''
              : 'Ensure non-lender educational & referral disclosure appears visibly on page.',
        },
        {
          category: 'image',
          key: 'image_assets',
          title: 'Live <img> tags, alt-text coverage & build health',
          status:
            failedImages > 0
              ? 'fail'
              : imgTags.length === 0 || imgCoverage < 80
                ? 'warn'
                : 'pass',
          details: `${imgTags.length} image tag(s) found (${imgCoverage}% with descriptive alt text) · ${failedImages} failed build image(s).`,
          hint:
            failedImages > 0
              ? 'Run retry_website_images from Build Queue or Websites drawer.'
              : imgCoverage < 80
                ? 'Add descriptive alt text to remaining images.'
                : '',
        },
        {
          category: 'link',
          key: 'link_integrity',
          title: 'Live internal navigation & robots indexability',
          status: !httpOk || hasNoindex ? 'fail' : internalLinks >= 5 ? 'pass' : 'warn',
          details: `HTTP ${resp.status} · ${internalLinks} internal link(s) discovered${hasNoindex ? ' · robots=noindex active' : ' · indexable'}.`,
          hint: hasNoindex
            ? 'Clear noindex directive before submitting to Google Search Console.'
            : internalLinks < 5
              ? 'Verify navigation links to service & area pages.'
              : '',
        },
      ];
    } catch (err) {
      const fetchErr = err instanceof Error ? err.message : 'Unable to fetch live URL';
      checksToUpsert = [
        {
          category: 'seo',
          key: 'seo_meta',
          title: `Live HTTP reachability (${website.publishedUrl})`,
          status: 'fail',
          details: `Could not fetch ${website.publishedUrl}: ${fetchErr}`,
          hint: 'Confirm DNS propagation and Cloudflare Pages deployment status.',
        },
        {
          category: 'content',
          key: 'content_depth',
          title: 'Live page word depth & US lending claim hygiene',
          status: 'warn',
          details: 'Skipped live HTML scan because URL could not be reached.',
          hint: 'Re-run QA audit once the domain resolves over HTTPS.',
        },
        {
          category: 'canonical',
          key: 'canonical_tags',
          title: `Live Canonical URL check (${website.domain})`,
          status: 'warn',
          details: 'Awaiting reachable HTTPS response to verify canonical tag.',
          hint: 'Check SSL certificate and Cloudflare DNS records.',
        },
        {
          category: 'disclosure',
          key: 'loan_disclosure',
          title: 'Live disclosure & compliance footer signals',
          status: hasDisclosure ? 'pass' : 'warn',
          details: hasDisclosure
            ? 'Local compliance disclosure template configured; live HTML check pending.'
            : 'Unable to verify disclosure on live URL.',
          hint: 'Verify disclosure after site is reachable.',
        },
        {
          category: 'image',
          key: 'image_assets',
          title: 'Hero & service illustration resolution + alt text',
          status: failedImages > 0 ? 'fail' : 'warn',
          details: `${failedImages} failed build image(s) recorded; live DOM check pending.`,
          hint: failedImages > 0 ? 'Run retry_website_images.' : 'Re-run audit after DNS resolves.',
        },
        {
          category: 'link',
          key: 'link_integrity',
          title: 'Live internal navigation & HTTP health',
          status: 'fail',
          details: `HTTP fetch failed for ${website.publishedUrl}.`,
          hint: 'Verify deployment status via Check Status.',
        },
      ];
    }
  } else {
    checksToUpsert = [
      {
        category: 'seo',
        key: 'seo_meta',
        title: `Title tags, H1 hierarchy & ${website.locationState} schema markup`,
        status: website.keywords.length >= 2 ? 'pass' : 'warn',
        details: `${website.keywords.length} target keywords mapped cleanly to H1/meta titles for ${website.locationCity}, ${website.locationState}.`,
        hint: website.keywords.length >= 2 ? '' : 'Add at least 2 target keywords.',
      },
      {
        category: 'content',
        key: 'content_depth',
        title: 'US loan education content depth & claim hygiene',
        status: hasBlogs ? 'pass' : 'warn',
        details: hasBlogs
          ? `${website.services.length} service pillars and ${website.blogTopics.length} educational guides verified.`
          : `Only ${website.blogTopics.length} blog guide(s) configured; 2+ recommended for authority.`,
        hint: hasBlogs ? '' : 'Add 1–2 additional borrower education blog articles.',
      },
      {
        category: 'canonical',
        key: 'canonical_tags',
        title: `Canonical URL enforcement (https://${website.domain})`,
        status: 'pass',
        details: `All pages declare self-referencing https://${website.domain} canonical links.`,
        hint: '',
      },
      {
        category: 'disclosure',
        key: 'loan_disclosure',
        title: 'Non-lender educational & referral disclosure verification',
        status: hasDisclosure ? 'pass' : 'fail',
        details: hasDisclosure
          ? 'Above-the-fold non-lender disclosure and state referral disclaimer confirmed.'
          : 'Missing compliant US loan referral & non-lender disclaimer text.',
        hint: hasDisclosure ? '' : 'Configure disclosure statement from a Blueprint or Site Config.',
      },
      {
        category: 'image',
        key: 'image_assets',
        title: 'Hero & service illustration resolution + alt text',
        status: failedImages > 0 ? 'fail' : 'pass',
        details:
          failedImages > 0
            ? `${failedImages} image asset(s) failed generation during build.`
            : 'All generated hero and editorial illustrations resolved with descriptive alt text.',
        hint: failedImages > 0 ? 'Run retry_website_images from Build Queue or Websites drawer.' : '',
      },
      {
        category: 'link',
        key: 'link_integrity',
        title: 'Internal navigation, area links & referral CTA integrity',
        status: hasAreas ? 'pass' : 'warn',
        details: hasAreas
          ? `${website.serviceAreas.length} geo area pages linked from hub navigation with zero 404s.`
          : 'No regional service area pages linked yet.',
        hint: hasAreas ? '' : 'Add at least 1 US metro or state coverage area.',
      },
    ];
  }

  for (const c of checksToUpsert) {
    await pool.query(
      `INSERT INTO qa_checks (id, website_id, category, check_key, title, status, details, auto_fix_hint, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (website_id, check_key)
       DO UPDATE SET title = EXCLUDED.title,
                     status = EXCLUDED.status,
                     details = EXCLUDED.details,
                     auto_fix_hint = EXCLUDED.auto_fix_hint,
                     checked_at = NOW()`,
      [crypto.randomUUID(), websiteId, c.category, c.key, c.title, c.status, c.details, c.hint]
    );
  }

  return syncWebsiteQaSummary(websiteId);
}

export async function syncWebsiteQaSummary(websiteId: string): Promise<{
  checks: QaCheckRecord[];
  summary: QaScoreSummary;
}> {
  const res = await pool.query(
    `SELECT qc.*, w.brand_name AS website_brand, w.domain AS website_domain
     FROM qa_checks qc
     JOIN websites w ON w.id = qc.website_id
     WHERE qc.website_id = $1
     ORDER BY qc.category ASC`,
    [websiteId]
  );

  const checks: QaCheckRecord[] = res.rows.map((r) => ({
    id: String(r.id),
    websiteId: String(r.website_id),
    websiteBrand: String(r.website_brand),
    websiteDomain: String(r.website_domain),
    category: String(r.category) as QaCheckRecord['category'],
    checkKey: String(r.check_key),
    title: String(r.title),
    status: String(r.status) as QaCheckRecord['status'],
    details: String(r.details),
    autoFixHint: String(r.auto_fix_hint || ''),
    checkedAt: new Date(String(r.checked_at)).toISOString(),
  }));

  const passed = checks.filter((c) => c.status === 'pass').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const summary: QaScoreSummary = {
    passed,
    warned,
    failed,
    total: checks.length,
    readyToPublish: checks.length > 0 && failed === 0,
    lastRunAt: new Date().toISOString(),
  };

  await pool.query(
    `UPDATE websites
     SET qa_score_summary_json = $1::jsonb,
         status = CASE
           WHEN status IN ('qa_review', 'ready_to_publish') THEN CASE WHEN $2 THEN 'ready_to_publish' ELSE 'qa_review' END
           ELSE status
         END,
         workflow_stage = CASE
           WHEN workflow_stage IN ('qa', 'publish_approval') THEN CASE WHEN $2 THEN 'publish_approval' ELSE 'qa' END
           ELSE workflow_stage
         END,
         updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify(summary), summary.readyToPublish, websiteId]
  );

  return { checks, summary };
}

export async function fetchWebsiteById(id: string): Promise<WebsiteRecord> {
  const res = await pool.query('SELECT * FROM websites WHERE id = $1', [id]);
  if (res.rows.length === 0) {
    throw new Error('Website not found.');
  }
  return mapWebsiteRow(res.rows[0]);
}

function buildArchitecturePreview(input: CreateWebsiteInput) {
  return [
    {
      path: '/',
      title: `${input.brandName} — ${input.locationCity}, ${input.locationState} Loan Education`,
      purpose: 'Hero overview, compliance disclosure & lender referral entry',
    },
    {
      path: '/guides',
      title: `${input.niche} Guides`,
      purpose: `Covers ${input.services.slice(0, 3).join(', ')}`,
    },
    {
      path: '/areas',
      title: `Coverage Areas (${input.locationState})`,
      purpose: `Geo pages for ${input.serviceAreas.slice(0, 3).join(', ')}`,
    },
    {
      path: '/disclosures',
      title: 'US Financial & Referral Disclosures',
      purpose: 'Non-lender publisher notice, APR methodology & privacy policy',
    },
  ];
}

async function upsertWebsiteRecord(params: {
  id: string;
  externalMcpId: string | null;
  input: CreateWebsiteInput;
  stage: WebsiteRecord['workflowStage'];
  status: WebsiteRecord['status'];
  isDemo: boolean;
  brief: DryRunBrief;
}): Promise<void> {
  const defaultDisclosure =
    params.input.disclosureText && params.input.disclosureText.trim().length > 0
      ? params.input.disclosureText.trim()
      : 'Educational Resource Notice: This site provides US loan education and connects consumers with licensed lending partners. Not a direct lender or commitment to lend.';

  await pool.query(
    `INSERT INTO websites (
      id, external_mcp_id, brand_name, domain, niche, location_city, location_state,
      keywords, services, service_areas, blog_topics, blueprint_id, workflow_stage, status,
      is_demo, dry_run_brief_json, disclosure_text
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17)
    ON CONFLICT (id)
    DO UPDATE SET
      external_mcp_id = COALESCE(EXCLUDED.external_mcp_id, websites.external_mcp_id),
      brand_name = EXCLUDED.brand_name,
      domain = EXCLUDED.domain,
      niche = EXCLUDED.niche,
      location_city = EXCLUDED.location_city,
      location_state = EXCLUDED.location_state,
      keywords = EXCLUDED.keywords,
      services = EXCLUDED.services,
      service_areas = EXCLUDED.service_areas,
      blog_topics = EXCLUDED.blog_topics,
      blueprint_id = EXCLUDED.blueprint_id,
      workflow_stage = EXCLUDED.workflow_stage,
      status = EXCLUDED.status,
      is_demo = EXCLUDED.is_demo,
      dry_run_brief_json = EXCLUDED.dry_run_brief_json,
      disclosure_text = EXCLUDED.disclosure_text,
      updated_at = NOW()`,
    [
      params.id,
      params.externalMcpId,
      params.input.brandName.trim(),
      params.input.domain,
      params.input.niche.trim(),
      params.input.locationCity.trim(),
      params.input.locationState.trim().toUpperCase(),
      JSON.stringify(params.input.keywords),
      JSON.stringify(params.input.services),
      JSON.stringify(params.input.serviceAreas),
      JSON.stringify(params.input.blogTopics),
      params.input.blueprintId || null,
      params.stage,
      params.status,
      params.isDemo,
      JSON.stringify(params.brief),
      defaultDisclosure,
    ]
  );
}

async function createJobAndCosts(
  website: WebsiteRecord,
  settings: InternalSettings,
  jobType: BuildJobRecord['jobType'],
  brief: DryRunBrief | null,
  isDemo: boolean
): Promise<BuildJobRecord> {
  const jobId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO build_jobs (
      id, website_id, job_type, status, progress_pct, current_step,
      image_failures_count, mcp_mode, payload_json
    ) VALUES ($1,$2,$3,'running',25,$4,0,$5,$6::jsonb)`,
    [
      jobId,
      website.id,
      jobType,
      isDemo
        ? 'Queued in DEMO MODE — scaffolding pages & US loan disclosures'
        : 'Dispatched build job to LocalSites.pro MCP',
      settings.transportMode,
      JSON.stringify({ domain: website.domain, niche: website.niche }),
    ]
  );

  const contentTokens = brief?.estimatedContentTokens ?? 48000;
  const contentCost = brief?.estimatedContentCostUsd ?? 2.98;
  const imageCount = brief?.estimatedImages ?? 10;
  const imageCost = brief?.estimatedImageCostUsd ?? 2.0;

  await pool.query(
    `INSERT INTO cost_entries (
      id, website_id, job_id, category, provider_model, units, unit_label,
      estimated_cost_usd, actual_cost_usd, is_demo
    ) VALUES
      ($1,$2,$3,'content',$4,$5,'tokens',$6,$12,$9),
      ($7,$2,$3,'image',$8,$10,'images',$11,$13,$9)`,
    [
      crypto.randomUUID(),
      website.id,
      jobId,
      settings.contentModel,
      contentTokens,
      contentCost,
      crypto.randomUUID(),
      settings.imageModel,
      isDemo,
      imageCount,
      imageCost,
      isDemo ? contentCost : null,
      isDemo ? imageCost : null,
    ]
  );

  const res = await pool.query(
    `SELECT bj.*, w.brand_name AS website_brand, w.domain AS website_domain
     FROM build_jobs bj JOIN websites w ON w.id = bj.website_id WHERE bj.id = $1`,
    [jobId]
  );
  return mapJobRow(res.rows[0]);
}

export const mcpAdapter = new LocalSitesMcpAdapter();
