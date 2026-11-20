import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  clearSessionCookie,
  createSessionToken,
  getAuthState,
  hashPasscode,
  requireOwnerAuth,
  setSessionCookie,
  verifyOwnerPasscode,
} from './auth.ts';
import { ensureDbReady, pool } from './db.ts';
import {
  fetchWebsiteById,
  getInternalSettings,
  mapJobRow,
  mapWebsiteRow,
  mcpAdapter,
  runFullQaAudit,
  syncWebsiteQaSummary,
  validateWebsiteConfig,
} from './mcpAdapter.ts';
import type {
  AppSettingsPublic,
  BlueprintRecord,
  CostEntryRecord,
  CreateWebsiteInput,
  OverviewData,
  QaCheckRecord,
} from '../shared/types.ts';

export const apiRouter = express.Router();

// Lightweight per-process limit for public owner authentication endpoints.
// Production deployments with multiple instances should add edge rate limiting.
const authAttempts = new Map<string, { count: number; expires: number }>();
function authRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.path}`;
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || entry.expires < now) {
    authAttempts.set(key, { count: 1, expires: now + 15 * 60 * 1000 });
    if (authAttempts.size > 2000) {
      for (const [k, value] of authAttempts) {
        if (value.expires < now) authAttempts.delete(k);
      }
    }
    next();
    return;
  }
  if (entry.count >= 8) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }
  entry.count += 1;
  next();
}


const createWebsiteSchema = z.object({
  websiteId: z.string().uuid().optional(),
  dryRun: z.boolean().default(true),
  input: z.object({
    brandName: z.string().min(1),
    domain: z.string().min(1),
    niche: z.string().min(1),
    siteType: z.enum(['city', 'state']).optional(),
    locationCity: z.string().default(''),
    locationState: z.string().min(1).max(20),
    email: z.string().optional(),
    phone: z.string().optional(),
    keywords: z.array(z.string()).default([]),
    services: z.array(z.string()).default([]),
    serviceAreas: z.array(z.string()).default([]),
    blogTopics: z.array(z.string()).default([]),
    blueprintId: z.string().uuid().nullable().optional(),
    disclosureText: z.string().optional(),
    testBuild: z.boolean().optional(),
    noindex: z.boolean().optional(),
    cloudflareAccount: z.string().optional(),
  }),
});

function maskSecret(val: string): string {
  if (!val) return '';
  if (val.length <= 6) return '••••••';
  return `••••••${val.slice(-4)}`;
}

function mapBlueprintRow(row: Record<string, unknown>): BlueprintRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    niche: String(row.niche),
    description: String(row.description),
    defaultKeywords: Array.isArray(row.default_keywords)
      ? (row.default_keywords as string[])
      : [],
    defaultServices: Array.isArray(row.default_services)
      ? (row.default_services as string[])
      : [],
    defaultBlogTopics: Array.isArray(row.default_blog_topics)
      ? (row.default_blog_topics as string[])
      : [],
    disclosureTemplate: String(row.disclosure_template || ''),
    promptInstructions: String(row.prompt_instructions || ''),
    modelPreset: String(row.model_preset || 'claude-3-7-sonnet'),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

apiRouter.get('/health', async (_req, res) => {
  try {
    await ensureDbReady();
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(500).json({
      ok: false,
      database: 'error',
      error: err instanceof Error ? err.message : 'Database connection error',
    });
  }
});

// Authentication Routes
apiRouter.get('/auth/status', async (req, res, next) => {
  try {
    const state = await getAuthState(req);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/auth/setup', authRateLimit, async (req, res, next) => {
  try {
    const state = await getAuthState(req);
    if (state.initialized) {
      res.status(409).json({ error: 'Owner passcode is already initialized.' });
      return;
    }
    const parsed = z.object({ passcode: z.string().min(6) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Passcode must be at least 6 characters.' });
      return;
    }
    const hash = hashPasscode(parsed.data.passcode);
    await pool.query(
      `INSERT INTO owner_auth (id, passcode_hash, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [hash]
    );
    const token = await createSessionToken();
    setSessionCookie(req, res, token);
    res.json({
      initialized: true,
      authenticated: true,
      envPasscodeManaged: false,
      sessionToken: token,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/auth/login', authRateLimit, async (req, res, next) => {
  try {
    const state = await getAuthState(req);
    if (!state.initialized) {
      res.status(400).json({ error: 'Owner passcode is not set up yet.' });
      return;
    }
    const parsed = z.object({ passcode: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Passcode is required.' });
      return;
    }
    const valid = await verifyOwnerPasscode(parsed.data.passcode);
    if (!valid) {
      res.status(401).json({ error: 'Invalid master passcode.' });
      return;
    }
    const token = await createSessionToken();
    setSessionCookie(req, res, token);
    res.json({
      initialized: true,
      authenticated: true,
      envPasscodeManaged: state.envPasscodeManaged,
      sessionToken: token,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

apiRouter.post('/auth/change-passcode', requireOwnerAuth, async (req, res, next) => {
  try {
    if (process.env.OWNER_PASSCODE?.trim()) {
      res.status(400).json({
        error:
          'Passcode is currently managed via OWNER_PASSCODE environment variable. Update it in your environment to rotate.',
      });
      return;
    }
    const parsed = z
      .object({
        currentPasscode: z.string().min(1),
        newPasscode: z.string().min(6),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'New passcode must be at least 6 characters.' });
      return;
    }
    const valid = await verifyOwnerPasscode(parsed.data.currentPasscode);
    if (!valid) {
      res.status(401).json({ error: 'Current passcode is incorrect.' });
      return;
    }
    const hash = hashPasscode(parsed.data.newPasscode);
    await pool.query(
      `INSERT INTO owner_auth (id, passcode_hash, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET passcode_hash = EXCLUDED.passcode_hash, updated_at = NOW()`,
      [hash]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Protect all operational routes
apiRouter.use(requireOwnerAuth);

apiRouter.get('/overview', async (_req, res, next) => {
  try {
    await ensureDbReady();
    const mcpStatus = await mcpAdapter.get_setup_status();

    const [websitesRes, jobsRes, costsRes, siteCostsRes] = await Promise.all([
      pool.query('SELECT * FROM websites ORDER BY is_demo ASC, updated_at DESC'),
      pool.query(
        `SELECT bj.*, w.brand_name AS website_brand, w.domain AS website_domain
         FROM build_jobs bj
         JOIN websites w ON w.id = bj.website_id
         ORDER BY bj.started_at DESC
         LIMIT 10`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(actual_cost_usd), 0)::float AS total_usd,
           COALESCE(SUM(CASE WHEN category = 'content' THEN actual_cost_usd ELSE 0 END), 0)::float AS content_usd,
           COALESCE(SUM(CASE WHEN category = 'image' THEN actual_cost_usd ELSE 0 END), 0)::float AS image_usd
         FROM cost_entries`
      ),
      pool.query(
        `SELECT
           w.id AS website_id,
           w.brand_name,
           w.domain,
           w.is_demo,
           COALESCE(SUM(CASE WHEN ce.category = 'content' THEN ce.actual_cost_usd ELSE 0 END), 0)::float AS content_usd,
           COALESCE(SUM(CASE WHEN ce.category = 'image' THEN ce.actual_cost_usd ELSE 0 END), 0)::float AS image_usd,
           COALESCE(SUM(ce.actual_cost_usd), 0)::float AS total_usd
         FROM websites w
         LEFT JOIN cost_entries ce ON ce.website_id = w.id
         GROUP BY w.id, w.brand_name, w.domain, w.is_demo
         HAVING COALESCE(SUM(ce.actual_cost_usd), 0) > 0
         ORDER BY total_usd DESC`
      ),
    ]);

    const websites = websitesRes.rows.map(mapWebsiteRow);
    const jobs = jobsRes.rows.map(mapJobRow);
    const costSummary = costsRes.rows[0] || {
      total_usd: 0,
      content_usd: 0,
      image_usd: 0,
    };

    const data: OverviewData = {
      mcpStatus,
      metrics: {
        totalWebsites: websites.length,
        publishedWebsites: websites.filter((w) => w.status === 'published').length,
        buildingWebsites: websites.filter((w) => w.status === 'building').length,
        failedJobs: jobs.filter((j) => j.status === 'failed').length,
        pendingApprovalCount: websites.filter(
          (w) => w.status === 'awaiting_approval' || w.status === 'ready_to_publish'
        ).length,
        qaBlockedCount: websites.filter((w) => w.status === 'qa_review').length,
        totalSpendUsd: Number(costSummary.total_usd || 0),
        contentSpendUsd: Number(costSummary.content_usd || 0),
        imageSpendUsd: Number(costSummary.image_usd || 0),
      },
      recentWebsites: websites.slice(0, 6),
      recentJobs: jobs.slice(0, 6),
      costByWebsite: siteCostsRes.rows.map((r) => ({
        websiteId: String(r.website_id),
        brandName: String(r.brand_name),
        domain: String(r.domain),
        contentUsd: Number(r.content_usd || 0),
        imageUsd: Number(r.image_usd || 0),
        totalUsd: Number(r.total_usd || 0),
        isDemo: Boolean(r.is_demo),
      })),
    };

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Websites Routes
apiRouter.get('/websites', async (_req, res, next) => {
  try {
    await ensureDbReady();
    const result = await pool.query(
      'SELECT * FROM websites ORDER BY is_demo ASC, updated_at DESC'
    );
    res.json({ websites: result.rows.map(mapWebsiteRow) });
  } catch (err) {
    next(err);
  }
});

apiRouter.get('/websites/:id', async (req, res, next) => {
  try {
    await ensureDbReady();
    const website = await fetchWebsiteById(req.params.id);
    const [jobsRes, qaRes, costsRes] = await Promise.all([
      pool.query(
        `SELECT bj.*, w.brand_name AS website_brand, w.domain AS website_domain
         FROM build_jobs bj JOIN websites w ON w.id = bj.website_id
         WHERE bj.website_id = $1 ORDER BY bj.started_at DESC`,
        [req.params.id]
      ),
      pool.query(
        'SELECT * FROM qa_checks WHERE website_id = $1 ORDER BY category ASC',
        [req.params.id]
      ),
      pool.query(
        'SELECT * FROM cost_entries WHERE website_id = $1 ORDER BY recorded_at DESC',
        [req.params.id]
      ),
    ]);
    res.json({
      website,
      jobs: jobsRes.rows.map(mapJobRow),
      qaChecks: qaRes.rows,
      costs: costsRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/websites/validate', async (req, res, next) => {
  try {
    const parsed = z
      .object({
        excludeWebsiteId: z.string().uuid().optional(),
        input: createWebsiteSchema.shape.input,
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid website configuration payload.' });
      return;
    }

    const result = await validateWebsiteConfig(
      parsed.data.input as CreateWebsiteInput,
      parsed.data.excludeWebsiteId
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.delete('/websites/demo/purge', async (_req, res, next) => {
  try {
    await ensureDbReady();
    const deleted = await pool.query('DELETE FROM websites WHERE is_demo = TRUE RETURNING id');
    res.json({ ok: true, deletedCount: deleted.rows.length });
  } catch (err) {
    next(err);
  }
});

apiRouter.delete('/websites/:id', async (req, res, next) => {
  try {
    await ensureDbReady();
    await pool.query('DELETE FROM websites WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// LocalSites.pro MCP Adapter Endpoints
apiRouter.get('/mcp/setup-status', async (_req, res, next) => {
  try {
    const status = await mcpAdapter.get_setup_status();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/mcp/list-websites', async (_req, res, next) => {
  try {
    const result = await mcpAdapter.list_websites();
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'MCP list_websites failed',
    });
  }
});

apiRouter.post('/mcp/create-website', async (req, res, next) => {
  try {
    const parsed = createWebsiteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid website payload.',
        details: parsed.error.flatten(),
      });
      return;
    }

    const validation = await validateWebsiteConfig(
      parsed.data.input as CreateWebsiteInput,
      parsed.data.websiteId
    );
    if (!validation.valid) {
      res.status(422).json({
        error: 'Site configuration failed validation.',
        validation,
      });
      return;
    }

    const result = await mcpAdapter.create_website({
      websiteId: parsed.data.websiteId,
      input: parsed.data.input as CreateWebsiteInput,
      dryRun: parsed.data.dryRun,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/mcp/website-status', async (req, res, next) => {
  try {
    const parsed = z.object({ websiteId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid websiteId is required.' });
      return;
    }
    const result = await mcpAdapter.get_website_status(parsed.data.websiteId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/mcp/clone-website', async (req, res, next) => {
  try {
    const parsed = z
      .object({
        sourceWebsiteId: z.string().uuid(),
        newBrandName: z.string().min(2),
        newDomain: z.string().min(4),
        locationCity: z.string().min(2),
        locationState: z.string().min(2).max(4),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid clone website payload.' });
      return;
    }
    const result = await mcpAdapter.clone_website(parsed.data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/mcp/stop-build', async (req, res, next) => {
  try {
    const parsed = z
      .object({ websiteId: z.string().uuid(), force: z.boolean().optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid websiteId is required.' });
      return;
    }
    const result = await mcpAdapter.stop_website_build(
      parsed.data.websiteId,
      Boolean(parsed.data.force)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/mcp/retry-images', async (req, res, next) => {
  try {
    const parsed = z.object({ websiteId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid websiteId is required.' });
      return;
    }
    const result = await mcpAdapter.retry_website_images(parsed.data.websiteId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/mcp/publish-website', async (req, res, next) => {
  try {
    const parsed = z
      .object({
        websiteId: z.string().uuid(),
        overrideQa: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid websiteId is required.' });
      return;
    }
    const result = await mcpAdapter.publish_website(
      parsed.data.websiteId,
      Boolean(parsed.data.overrideQa)
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Publish failed',
    });
  }
});

// Build Queue Routes
apiRouter.get('/jobs', async (_req, res, next) => {
  try {
    await ensureDbReady();
    const result = await pool.query(
      `SELECT bj.*, w.brand_name AS website_brand, w.domain AS website_domain
       FROM build_jobs bj
       JOIN websites w ON w.id = bj.website_id
       ORDER BY bj.started_at DESC`
    );
    res.json({ jobs: result.rows.map(mapJobRow) });
  } catch (err) {
    next(err);
  }
});

// QA Center Routes
apiRouter.get('/qa', async (req, res, next) => {
  try {
    await ensureDbReady();
    const websiteId = typeof req.query.websiteId === 'string' ? req.query.websiteId : '';
    const websitesRes = await pool.query('SELECT * FROM websites ORDER BY updated_at DESC');
    const checksQuery = websiteId
      ? pool.query(
          `SELECT qc.*, w.brand_name AS website_brand, w.domain AS website_domain
           FROM qa_checks qc JOIN websites w ON w.id = qc.website_id
           WHERE qc.website_id = $1 ORDER BY qc.category ASC`,
          [websiteId]
        )
      : pool.query(
          `SELECT qc.*, w.brand_name AS website_brand, w.domain AS website_domain
           FROM qa_checks qc JOIN websites w ON w.id = qc.website_id
           ORDER BY w.updated_at DESC, qc.category ASC`
        );

    const checksRes = await checksQuery;
    const checks: QaCheckRecord[] = checksRes.rows.map((r) => ({
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

    res.json({
      checks,
      websites: websitesRes.rows.map(mapWebsiteRow),
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/qa/:websiteId/run', async (req, res, next) => {
  try {
    const result = await runFullQaAudit(req.params.websiteId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

apiRouter.patch('/qa/check/:checkId', async (req, res, next) => {
  try {
    await ensureDbReady();
    const parsed = z
      .object({
        status: z.enum(['pass', 'warn', 'fail']),
        details: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid QA check update.' });
      return;
    }

    const updated = await pool.query(
      `UPDATE qa_checks
       SET status = $1,
           details = COALESCE($2, details),
           checked_at = NOW()
       WHERE id = $3
       RETURNING website_id`,
      [parsed.data.status, parsed.data.details ?? null, req.params.checkId]
    );

    if (updated.rows.length === 0) {
      res.status(404).json({ error: 'QA check not found.' });
      return;
    }
    const result = await syncWebsiteQaSummary(String(updated.rows[0].website_id));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Blueprints Routes
apiRouter.get('/blueprints', async (_req, res, next) => {
  try {
    await ensureDbReady();
    const result = await pool.query('SELECT * FROM blueprints ORDER BY updated_at DESC');
    res.json({ blueprints: result.rows.map(mapBlueprintRow) });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/blueprints', async (req, res, next) => {
  try {
    await ensureDbReady();
    const parsed = z
      .object({
        name: z.string().min(2),
        niche: z.string().min(2),
        description: z.string().min(4),
        defaultKeywords: z.array(z.string()).default([]),
        defaultServices: z.array(z.string()).default([]),
        defaultBlogTopics: z.array(z.string()).default([]),
        disclosureTemplate: z.string().min(10),
        promptInstructions: z.string().default(''),
        modelPreset: z.string().default('claude-3-7-sonnet'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid blueprint data.' });
      return;
    }
    const id = crypto.randomUUID();
    const d = parsed.data;
    const result = await pool.query(
      `INSERT INTO blueprints (
        id, name, niche, description, default_keywords, default_services,
        default_blog_topics, disclosure_template, prompt_instructions, model_preset
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)
      RETURNING *`,
      [
        id,
        d.name,
        d.niche,
        d.description,
        JSON.stringify(d.defaultKeywords),
        JSON.stringify(d.defaultServices),
        JSON.stringify(d.defaultBlogTopics),
        d.disclosureTemplate,
        d.promptInstructions,
        d.modelPreset,
      ]
    );
    res.status(201).json({ blueprint: mapBlueprintRow(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

apiRouter.put('/blueprints/:id', async (req, res, next) => {
  try {
    await ensureDbReady();
    const parsed = z
      .object({
        name: z.string().min(2),
        niche: z.string().min(2),
        description: z.string().min(4),
        defaultKeywords: z.array(z.string()).default([]),
        defaultServices: z.array(z.string()).default([]),
        defaultBlogTopics: z.array(z.string()).default([]),
        disclosureTemplate: z.string().min(10),
        promptInstructions: z.string().default(''),
        modelPreset: z.string().default('claude-3-7-sonnet'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid blueprint payload.' });
      return;
    }
    const d = parsed.data;
    const result = await pool.query(
      `UPDATE blueprints
       SET name = $1, niche = $2, description = $3,
           default_keywords = $4::jsonb, default_services = $5::jsonb,
           default_blog_topics = $6::jsonb, disclosure_template = $7,
           prompt_instructions = $8, model_preset = $9, updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        d.name,
        d.niche,
        d.description,
        JSON.stringify(d.defaultKeywords),
        JSON.stringify(d.defaultServices),
        JSON.stringify(d.defaultBlogTopics),
        d.disclosureTemplate,
        d.promptInstructions,
        d.modelPreset,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Blueprint not found.' });
      return;
    }
    res.json({ blueprint: mapBlueprintRow(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

apiRouter.delete('/blueprints/:id', async (req, res, next) => {
  try {
    await ensureDbReady();
    await pool.query('DELETE FROM blueprints WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Cost Analytics Routes
apiRouter.get('/costs', async (_req, res, next) => {
  try {
    await ensureDbReady();
    const [entriesRes, perSiteRes] = await Promise.all([
      pool.query(
        `SELECT ce.*, w.brand_name AS website_brand, w.domain AS website_domain
         FROM cost_entries ce
         JOIN websites w ON w.id = ce.website_id
         ORDER BY ce.recorded_at DESC`
      ),
      pool.query(
        `SELECT
           w.id AS website_id,
           w.brand_name,
           w.domain,
           w.niche,
           w.is_demo,
           COALESCE(SUM(CASE WHEN ce.category = 'content' THEN ce.actual_cost_usd ELSE 0 END), 0)::float AS content_usd,
           COALESCE(SUM(CASE WHEN ce.category = 'image' THEN ce.actual_cost_usd ELSE 0 END), 0)::float AS image_usd,
           COALESCE(SUM(ce.estimated_cost_usd), 0)::float AS estimated_usd,
           COALESCE(SUM(ce.actual_cost_usd), 0)::float AS actual_usd
         FROM websites w
         LEFT JOIN cost_entries ce ON ce.website_id = w.id
         GROUP BY w.id, w.brand_name, w.domain, w.niche, w.is_demo
         ORDER BY actual_usd DESC`
      ),
    ]);

    const entries: CostEntryRecord[] = entriesRes.rows.map((r) => ({
      id: String(r.id),
      websiteId: String(r.website_id),
      websiteBrand: String(r.website_brand),
      websiteDomain: String(r.website_domain),
      jobId: r.job_id ? String(r.job_id) : null,
      category: String(r.category) as CostEntryRecord['category'],
      providerModel: String(r.provider_model),
      units: Number(r.units || 0),
      unitLabel: String(r.unit_label || 'units'),
      estimatedCostUsd: Number(r.estimated_cost_usd || 0),
      actualCostUsd: r.actual_cost_usd === null ? null : Number(r.actual_cost_usd),
      isDemo: Boolean(r.is_demo),
      recordedAt: new Date(String(r.recorded_at)).toISOString(),
    }));

    const perWebsite = perSiteRes.rows.map((r) => ({
      websiteId: String(r.website_id),
      brandName: String(r.brand_name),
      domain: String(r.domain),
      niche: String(r.niche),
      isDemo: Boolean(r.is_demo),
      contentUsd: Number(r.content_usd || 0),
      imageUsd: Number(r.image_usd || 0),
      estimatedUsd: Number(r.estimated_usd || 0),
      actualUsd: Number(r.actual_usd || 0),
    }));

    res.json({ entries, perWebsite });
  } catch (err) {
    next(err);
  }
});

// Settings Routes (server-side credentials masked, never leaked to browser)
apiRouter.get('/settings', async (_req, res, next) => {
  try {
    const s = await getInternalSettings();
    const rowRes = await pool.query('SELECT updated_at FROM app_settings WHERE id = 1');
    const updatedAt = rowRes.rows[0]?.updated_at
      ? new Date(String(rowRes.rows[0].updated_at)).toISOString()
      : new Date().toISOString();

    const publicSettings: AppSettingsPublic = {
      transportMode: s.transportMode,
      mcpEndpointUrl: s.mcpEndpointUrl,
      mcpAuthType: s.mcpAuthType,
      hasMcpApiKey: Boolean(s.mcpApiKey),
      maskedMcpApiKey: maskSecret(s.mcpApiKey),
      stdioCommand: s.stdioCommand,
      stdioArgs: s.stdioArgs,
      hasStdioEnv: Boolean(s.stdioEnvJson && s.stdioEnvJson.trim() !== '{}'),
      contentModel: s.contentModel,
      imageModel: s.imageModel,
      monthlyBudgetLimitUsd: s.monthlyBudgetLimitUsd,
      requireQaPassBeforePublish: s.requireQaPassBeforePublish,
      updatedAt,
    };

    const mcpStatus = await mcpAdapter.get_setup_status();
    res.json({ settings: publicSettings, mcpStatus });
  } catch (err) {
    next(err);
  }
});

apiRouter.put('/settings', async (req, res, next) => {
  try {
    await ensureDbReady();
    const parsed = z
      .object({
        transportMode: z.enum(['demo', 'http_sse', 'stdio']),
        mcpEndpointUrl: z.string().default(''),
        mcpAuthType: z.enum(['bearer', 'api_key', 'none']).default('bearer'),
        mcpApiKey: z.string().optional(),
        clearMcpApiKey: z.boolean().optional(),
        stdioCommand: z.string().default(''),
        stdioArgs: z.string().default(''),
        stdioEnvJson: z.string().optional(),
        contentModel: z.string().min(1),
        imageModel: z.string().min(1),
        monthlyBudgetLimitUsd: z.number().min(10).max(50000),
        requireQaPassBeforePublish: z.boolean(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid settings payload.' });
      return;
    }

    const d = parsed.data;
    const current = await getInternalSettings();

    let nextApiKey = current.mcpApiKey;
    if (d.clearMcpApiKey) {
      nextApiKey = '';
    } else if (typeof d.mcpApiKey === 'string' && d.mcpApiKey.trim().length > 0) {
      nextApiKey = d.mcpApiKey.trim();
    }

    let nextStdioEnv = current.stdioEnvJson;
    if (typeof d.stdioEnvJson === 'string' && d.stdioEnvJson.trim().length > 0) {
      try {
        JSON.parse(d.stdioEnvJson);
        nextStdioEnv = d.stdioEnvJson.trim();
      } catch {
        res.status(400).json({ error: 'Stdio environment variables must be valid JSON.' });
        return;
      }
    }

    await pool.query(
      `UPDATE app_settings
       SET transport_mode = $1,
           mcp_endpoint_url = $2,
           mcp_auth_type = $3,
           mcp_api_key = $4,
           stdio_command = $5,
           stdio_args = $6,
           stdio_env_json = $7,
           content_model = $8,
           image_model = $9,
           monthly_budget_limit_usd = $10,
           require_qa_pass_before_publish = $11,
           updated_at = NOW()
       WHERE id = 1`,
      [
        d.transportMode,
        d.mcpEndpointUrl.trim(),
        d.mcpAuthType,
        nextApiKey,
        d.stdioCommand.trim(),
        d.stdioArgs.trim(),
        nextStdioEnv,
        d.contentModel,
        d.imageModel,
        d.monthlyBudgetLimitUsd,
        d.requireQaPassBeforePublish,
      ]
    );

    const mcpStatus = await mcpAdapter.get_setup_status();
    const updated = await getInternalSettings();
    const publicSettings: AppSettingsPublic = {
      transportMode: updated.transportMode,
      mcpEndpointUrl: updated.mcpEndpointUrl,
      mcpAuthType: updated.mcpAuthType,
      hasMcpApiKey: Boolean(updated.mcpApiKey),
      maskedMcpApiKey: maskSecret(updated.mcpApiKey),
      stdioCommand: updated.stdioCommand,
      stdioArgs: updated.stdioArgs,
      hasStdioEnv: Boolean(updated.stdioEnvJson && updated.stdioEnvJson.trim() !== '{}'),
      contentModel: updated.contentModel,
      imageModel: updated.imageModel,
      monthlyBudgetLimitUsd: updated.monthlyBudgetLimitUsd,
      requireQaPassBeforePublish: updated.requireQaPassBeforePublish,
      updatedAt: new Date().toISOString(),
    };

    res.json({ settings: publicSettings, mcpStatus });
  } catch (err) {
    next(err);
  }
});
