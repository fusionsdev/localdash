import crypto from 'node:crypto';
import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || '';

if (!connectionString) {
  console.warn(
    '[Website Factory] DATABASE_URL / DATABASE_URL_POOLED is not set. Database operations will fail until configured.'
  );
}

export const pool = new Pool({
  connectionString,
  ssl:
    connectionString.includes('sslmode=require') ||
    connectionString.includes('neon.tech')
      ? { rejectUnauthorized: false }
      : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let initPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (!initPromise) {
    initPromise = initializeSchemaAndSeed().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function initializeSchemaAndSeed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS owner_auth (
        id INTEGER PRIMARY KEY DEFAULT 1,
        passcode_hash TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        transport_mode TEXT NOT NULL DEFAULT 'demo',
        mcp_endpoint_url TEXT NOT NULL DEFAULT '',
        mcp_auth_type TEXT NOT NULL DEFAULT 'bearer',
        mcp_api_key TEXT NOT NULL DEFAULT '',
        stdio_command TEXT NOT NULL DEFAULT '',
        stdio_args TEXT NOT NULL DEFAULT '',
        stdio_env_json TEXT NOT NULL DEFAULT '{}',
        content_model TEXT NOT NULL DEFAULT 'claude-3-7-sonnet',
        image_model TEXT NOT NULL DEFAULT 'flux-1.1-pro',
        monthly_budget_limit_usd NUMERIC(10, 2) NOT NULL DEFAULT 250.00,
        require_qa_pass_before_publish BOOLEAN NOT NULL DEFAULT TRUE,
        session_secret TEXT NOT NULL DEFAULT '',
        demo_seeded BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS blueprints (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        niche TEXT NOT NULL,
        description TEXT NOT NULL,
        default_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        default_services JSONB NOT NULL DEFAULT '[]'::jsonb,
        default_blog_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
        disclosure_template TEXT NOT NULL,
        prompt_instructions TEXT NOT NULL,
        model_preset TEXT NOT NULL DEFAULT 'claude-3-7-sonnet',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS websites (
        id UUID PRIMARY KEY,
        external_mcp_id TEXT,
        brand_name TEXT NOT NULL,
        domain TEXT NOT NULL UNIQUE,
        niche TEXT NOT NULL,
        location_city TEXT NOT NULL,
        location_state TEXT NOT NULL,
        keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        services JSONB NOT NULL DEFAULT '[]'::jsonb,
        service_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
        blog_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
        blueprint_id UUID REFERENCES blueprints(id) ON DELETE SET NULL,
        workflow_stage TEXT NOT NULL DEFAULT 'configuration',
        status TEXT NOT NULL DEFAULT 'draft',
        is_demo BOOLEAN NOT NULL DEFAULT TRUE,
        dry_run_brief_json JSONB,
        qa_score_summary_json JSONB,
        published_url TEXT,
        disclosure_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS build_jobs (
        id UUID PRIMARY KEY,
        website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_pct INTEGER NOT NULL DEFAULT 0,
        current_step TEXT NOT NULL DEFAULT '',
        image_failures_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        mcp_mode TEXT NOT NULL DEFAULT 'demo',
        payload_json JSONB,
        result_json JSONB,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS qa_checks (
        id UUID PRIMARY KEY,
        website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        check_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT NOT NULL,
        auto_fix_hint TEXT NOT NULL DEFAULT '',
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (website_id, check_key)
      );

      CREATE TABLE IF NOT EXISTS cost_entries (
        id UUID PRIMARY KEY,
        website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        job_id UUID REFERENCES build_jobs(id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        provider_model TEXT NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        unit_label TEXT NOT NULL DEFAULT 'tokens',
        estimated_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
        actual_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
        is_demo BOOLEAN NOT NULL DEFAULT TRUE,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Missing provider costs remain unknown rather than being reported as zero.
      ALTER TABLE cost_entries ALTER COLUMN actual_cost_usd DROP NOT NULL;
      UPDATE cost_entries SET actual_cost_usd = NULL
        WHERE is_demo = FALSE AND actual_cost_usd = estimated_cost_usd;

      ALTER TABLE websites ADD COLUMN IF NOT EXISTS engine TEXT DEFAULT 'local';
      ALTER TABLE websites ADD COLUMN IF NOT EXISTS site_type TEXT DEFAULT 'city';
      ALTER TABLE websites ADD COLUMN IF NOT EXISTS indexed_pages INTEGER;
    `);

    const envTransport =
      process.env.LOCALSITES_MCP_TRANSPORT === 'http_sse' ||
      process.env.LOCALSITES_MCP_TRANSPORT === 'stdio'
        ? process.env.LOCALSITES_MCP_TRANSPORT
        : 'demo';

    const generatedSecret = crypto.randomBytes(32).toString('hex');

    await client.query(
      `INSERT INTO app_settings (
        id, transport_mode, mcp_endpoint_url, mcp_api_key, stdio_command, stdio_args, session_secret, demo_seeded
      ) VALUES (1, $1, $2, $3, $4, $5, $6, FALSE)
      ON CONFLICT (id) DO NOTHING`,
      [
        envTransport,
        process.env.LOCALSITES_MCP_URL || '',
        process.env.LOCALSITES_MCP_API_KEY || '',
        process.env.LOCALSITES_MCP_STDIO_COMMAND || '',
        process.env.LOCALSITES_MCP_STDIO_ARGS || '',
        generatedSecret,
      ]
    );

    const settingsRes = await client.query(
      'SELECT demo_seeded FROM app_settings WHERE id = 1'
    );
    const alreadySeeded = Boolean(settingsRes.rows[0]?.demo_seeded);

    if (!alreadySeeded) {
      await seedDemoData(client);
      await client.query('UPDATE app_settings SET demo_seeded = TRUE WHERE id = 1');
    }
  } finally {
    client.release();
  }
}

async function seedDemoData(client: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const bp1 = '11111111-1111-4111-8111-111111111101';
  const bp2 = '11111111-1111-4111-8111-111111111102';
  const bp3 = '11111111-1111-4111-8111-111111111103';
  const bp4 = '11111111-1111-4111-8111-111111111104';

  const blueprints = [
    {
      id: bp1,
      name: 'FHA & First-Time Homebuyer Hub',
      niche: 'Mortgage & Homebuyer Education',
      description:
        'State-localized FHA, down payment assistance, and first-time mortgage education blueprint with TILA/RESPA referral disclosures.',
      keywords: [
        'FHA loan requirements',
        'first time homebuyer grants',
        'down payment assistance programs',
        'mortgage pre-approval checklist',
      ],
      services: [
        'FHA Loan Eligibility Guides',
        'State Down Payment Assistance Directory',
        'Mortgage Rate Comparison Education',
        'Licensed Lender Matching Referral',
      ],
      blogs: [
        '2026 FHA Loan Limits and Credit Score Rules Explained',
        'How Debt-to-Income Ratio Impacts Mortgage Approval',
        'Comparing FHA vs Conventional Loans for First-Time Buyers',
      ],
      disclosure:
        'Educational Resource Notice: This site provides US mortgage education and connects consumers with NMLS-licensed lending partners. Not a direct lender or commitment to lend.',
      prompt:
        'Authoritative, plain-English US mortgage education tone. Avoid rate promises; include representative APR ranges and NMLS referral disclosures.',
      model: 'claude-3-7-sonnet',
    },
    {
      id: bp2,
      name: 'Personal & Debt Consolidation Referral Guide',
      niche: 'Personal Loans & Debt Consolidation',
      description:
        'Regional personal loan education portal covering APR comparisons, credit impact, and debt consolidation math.',
      keywords: [
        'personal loan APR guide',
        'debt consolidation loan calculator',
        'fixed rate installment loans',
        'credit score personal loan tiers',
      ],
      services: [
        'Debt Consolidation Guides',
        'APR & Origination Fee Breakdowns',
        'Personal Loan Pre-Qualification Education',
        'Matched Lender Referral Network',
      ],
      blogs: [
        'APR vs Interest Rate: What Borrowers Need to Check Before Signing',
        'When Debt Consolidation Lowers Total Repayment Cost',
        'Soft Credit Pulls vs Hard Inquiries During Rate Shopping',
      ],
      disclosure:
        'Advertising Disclosure: This website is an independent educational publisher and loan referral service. Loan terms, APRs, and eligibility vary by state and lender underwriting.',
      prompt:
        'Consumer-advocate financial literacy tone. Include clear APR example tables and emphasize soft-pull pre-qualification transparency.',
      model: 'claude-3-7-sonnet',
    },
    {
      id: bp3,
      name: 'SBA 7(a) & Small Business Capital Directory',
      niche: 'Small Business & SBA Financing',
      description:
        'Commercial education and referral blueprint for SBA 7(a), 504, working capital lines, and equipment financing.',
      keywords: [
        'SBA 7a loan requirements',
        'small business working capital guide',
        'SBA Express lender directory',
        'business line of credit comparison',
      ],
      services: [
        'SBA 7(a) & 504 Readiness Guides',
        'Business Cash Flow & DSCR Education',
        'Equipment Financing Comparisons',
        'Commercial Lender Referral Matching',
      ],
      blogs: [
        'Documents Required for an SBA 7(a) Loan Package',
        'Understanding DSCR and Collateral Expectations for Small Businesses',
        'Term Loans vs Revolving Lines of Credit for Seasonal Revenue',
      ],
      disclosure:
        'Commercial Financing Disclosure: Educational content only. Financing products are offered through participating commercial lenders and SBA-approved institutions.',
      prompt:
        'Practical CFO-level clarity for US small business owners. Focus on eligibility documentation, realistic funding timelines, and fee structures.',
      model: 'gpt-4.1',
    },
    {
      id: bp4,
      name: 'VA & Military Mortgage Resource Portal',
      niche: 'VA Loans & Military Housing',
      description:
        'Dedicated COE, VA funding fee, and IRRRL streamline refinance education hub for active-duty and veteran borrowers.',
      keywords: [
        'VA loan COE guide',
        'VA funding fee exemptions',
        'VA IRRRL refinance checklist',
        'zero down veteran mortgage rules',
      ],
      services: [
        'Certificate of Eligibility (COE) Guides',
        'VA Funding Fee Exemption Calculators',
        'VA IRRRL Streamline Refinance Education',
        'VA-Approved Lender Referral',
      ],
      blogs: [
        'How to Request Your VA Certificate of Eligibility Online',
        'VA Appraisal Minimum Property Requirements Simplified',
        'When a VA Streamline Refinance Makes Financial Sense',
      ],
      disclosure:
        'Notice: Not affiliated with the U.S. Department of Veterans Affairs. Educational content and referrals to private VA-approved mortgage lenders.',
      prompt:
        'Respectful, clear, accurate guidance tailored to military families. Never imply government endorsement.',
      model: 'claude-3-7-sonnet',
    },
  ];

  for (const bp of blueprints) {
    await client.query(
      `INSERT INTO blueprints (
        id, name, niche, description, default_keywords, default_services, default_blog_topics,
        disclosure_template, prompt_instructions, model_preset
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING`,
      [
        bp.id,
        bp.name,
        bp.niche,
        bp.description,
        JSON.stringify(bp.keywords),
        JSON.stringify(bp.services),
        JSON.stringify(bp.blogs),
        bp.disclosure,
        bp.prompt,
        bp.model,
      ]
    );
  }

  const w1 = '22222222-2222-4222-8222-222222222201';
  const w2 = '22222222-2222-4222-8222-222222222202';
  const w3 = '22222222-2222-4222-8222-222222222203';
  const w4 = '22222222-2222-4222-8222-222222222204';
  const w5 = '22222222-2222-4222-8222-222222222205';
  const w6 = '22222222-2222-4222-8222-222222222206';

  const makeBrief = (
    brand: string,
    pages: number,
    images: number,
    contentUsd: number,
    imageUsd: number
  ) => ({
    mode: 'demo',
    isDemo: true,
    estimatedPages: pages,
    estimatedImages: images,
    estimatedContentTokens: pages * 3800,
    estimatedContentCostUsd: contentUsd,
    estimatedImageCostUsd: imageUsd,
    estimatedTotalCostUsd: Number((contentUsd + imageUsd).toFixed(2)),
    estimatedDurationMinutes: Math.max(4, Math.round(pages * 0.45)),
    siteArchitecture: [
      { path: '/', title: `${brand} Home & Loan Education Hub`, purpose: 'Hero overview, compliance disclosure & lender referral CTA' },
      { path: '/guides', title: 'Borrower Education Guides', purpose: 'Eligibility criteria, APR breakdowns & credit readiness' },
      { path: '/areas', title: 'State & Metro Coverage Directory', purpose: 'Geo-targeted local lending programs & housing assistance' },
      { path: '/disclosures', title: 'Licensing & Referral Disclosures', purpose: 'TILA/state licensing statements & editorial methodology' },
    ],
    complianceNotes: [
      'Includes non-lender educational publisher disclaimer above the fold',
      'Representative APR and term examples formatted without guaranteed-approval claims',
    ],
    warnings: [],
    generatedAt: '2026-11-15T14:20:00.000Z',
  });

  const websites = [
    {
      id: w1,
      extId: 'demo_ls_101',
      brand: 'Lone Star Home Loans Edu',
      domain: 'lonestarhomeloansedu.com',
      niche: 'Mortgage & Homebuyer Education',
      city: 'Austin',
      state: 'TX',
      keywords: ['Texas FHA loan limits', 'Austin first time homebuyer guide', 'TDHCA down payment assistance'],
      services: ['FHA Loan Eligibility Guides', 'VA Home Loan Resources', 'Texas Down Payment Programs'],
      areas: ['Austin, TX', 'Dallas-Fort Worth, TX', 'Houston, TX', 'San Antonio, TX'],
      blogs: ['Texas Homestead Exemption & Property Tax Escrow Guide', '2026 FHA Loan Limits Across Texas Counties'],
      blueprintId: bp1,
      stage: 'published',
      status: 'published',
      brief: makeBrief('Lone Star Home Loans Edu', 18, 12, 4.15, 2.40),
      qa: { passed: 6, warned: 0, failed: 0, total: 6, readyToPublish: true, lastRunAt: '2026-11-16T09:10:00.000Z' },
      publishedUrl: 'https://lonestarhomeloansedu.com',
      disclosure: blueprints[0].disclosure,
    },
    {
      id: w2,
      extId: 'demo_ls_102',
      brand: 'Midwest Debt Relief Guide',
      domain: 'midwestdebtreliefguide.org',
      niche: 'Personal Loans & Debt Consolidation',
      city: 'Columbus',
      state: 'OH',
      keywords: ['Ohio debt consolidation loans', 'personal loan APR comparison', 'fixed installment loan guide'],
      services: ['Debt Consolidation Calculators', 'Personal Loan Tier Guides', 'Credit Card Payoff Comparisons'],
      areas: ['Columbus, OH', 'Cleveland, OH', 'Cincinnati, OH', 'Indianapolis, IN'],
      blogs: ['How Fixed-Rate Consolidation Differs from Balance Transfers', 'Understanding Ohio Interest Cap Rules'],
      blueprintId: bp2,
      stage: 'published',
      status: 'published',
      brief: makeBrief('Midwest Debt Relief Guide', 16, 10, 3.60, 2.00),
      qa: { passed: 6, warned: 0, failed: 0, total: 6, readyToPublish: true, lastRunAt: '2026-11-15T18:30:00.000Z' },
      publishedUrl: 'https://midwestdebtreliefguide.org',
      disclosure: blueprints[1].disclosure,
    },
    {
      id: w3,
      extId: 'demo_ls_103',
      brand: 'Sunbelt SBA Capital Hub',
      domain: 'sunbeltsbacapitalhub.com',
      niche: 'Small Business & SBA Financing',
      city: 'Tampa',
      state: 'FL',
      keywords: ['Florida SBA 7a loans', 'small business working capital Tampa', 'SBA 504 commercial real estate'],
      services: ['SBA 7(a) Eligibility Guides', 'Working Capital Line Education', 'Equipment Financing Directory'],
      areas: ['Tampa Bay, FL', 'Miami, FL', 'Orlando, FL', 'Jacksonville, FL'],
      blogs: ['Preparing Tax Returns & P&L Statements for SBA Underwriting', 'Comparing SBA Express vs Traditional 7(a) Timelines'],
      blueprintId: bp3,
      stage: 'qa',
      status: 'qa_review',
      brief: makeBrief('Sunbelt SBA Capital Hub', 20, 14, 4.85, 2.80),
      qa: { passed: 4, warned: 1, failed: 1, total: 6, readyToPublish: false, lastRunAt: '2026-11-18T10:15:00.000Z' },
      publishedUrl: null,
      disclosure: blueprints[2].disclosure,
    },
    {
      id: w4,
      extId: 'demo_ls_104',
      brand: 'Pacific Auto Refi Edu',
      domain: 'pacificautorefiedu.com',
      niche: 'Auto Loan Refinancing Education',
      city: 'San Diego',
      state: 'CA',
      keywords: ['California auto loan refinance', 'lower car payment APR guide', 'credit union auto refi rules'],
      services: ['Auto Refinance Break-Even Guides', 'LTV & Mileage Eligibility Info', 'California DMV Lien Transfer FAQ'],
      areas: ['San Diego, CA', 'Los Angeles, CA', 'Sacramento, CA', 'San Jose, CA'],
      blogs: ['When Auto Loan Refinancing Saves Money After Rate Drops', 'Gap Insurance & Title Transfer Steps in California'],
      blueprintId: bp2,
      stage: 'monitoring',
      status: 'building',
      brief: makeBrief('Pacific Auto Refi Edu', 14, 9, 3.10, 1.80),
      qa: null,
      publishedUrl: null,
      disclosure: blueprints[1].disclosure,
    },
    {
      id: w5,
      extId: 'demo_ls_105',
      brand: 'Peach State Personal Credit',
      domain: 'peachstatepersonalcredit.com',
      niche: 'Personal Loans & Debt Consolidation',
      city: 'Atlanta',
      state: 'GA',
      keywords: ['Georgia personal installment loans', 'Atlanta credit builder education', 'unsecured loan APR guide'],
      services: ['Installment Loan Education', 'Credit Score Factor Breakdowns', 'Georgia Lender Licensing Guide'],
      areas: ['Atlanta, GA', 'Savannah, GA', 'Augusta, GA'],
      blogs: ['Comparing Secured vs Unsecured Personal Loans in Georgia', 'How Origination Fees Affect Effective APR'],
      blueprintId: bp2,
      stage: 'monitoring',
      status: 'failed',
      brief: makeBrief('Peach State Personal Credit', 15, 10, 3.30, 2.00),
      qa: null,
      publishedUrl: null,
      disclosure: blueprints[1].disclosure,
    },
    {
      id: w6,
      extId: null,
      brand: 'Keystone Home Equity Edu',
      domain: 'keystonehomeequityedu.com',
      niche: 'HELOC & Home Equity Education',
      city: 'Pittsburgh',
      state: 'PA',
      keywords: ['Pennsylvania HELOC guide', 'home equity loan vs HELOC', 'CLTV borrowing limits PA'],
      services: ['HELOC Draw Period Education', 'Fixed Home Equity Comparisons', 'CLTV Calculator & Readiness'],
      areas: ['Pittsburgh, PA', 'Philadelphia, PA', 'Harrisburg, PA'],
      blogs: ['Variable HELOC Rates vs Fixed Home Equity Loans in 2026', 'Understanding Combined Loan-to-Value (CLTV) Caps'],
      blueprintId: bp1,
      stage: 'user_approval',
      status: 'awaiting_approval',
      brief: makeBrief('Keystone Home Equity Edu', 16, 11, 3.75, 2.20),
      qa: null,
      publishedUrl: null,
      disclosure: blueprints[0].disclosure,
    },
  ];

  for (const w of websites) {
    await client.query(
      `INSERT INTO websites (
        id, external_mcp_id, brand_name, domain, niche, location_city, location_state,
        keywords, services, service_areas, blog_topics, blueprint_id, workflow_stage, status,
        is_demo, dry_run_brief_json, qa_score_summary_json, published_url, disclosure_text
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,TRUE,$15::jsonb,$16::jsonb,$17,$18)
      ON CONFLICT (id) DO NOTHING`,
      [
        w.id,
        w.extId,
        w.brand,
        w.domain,
        w.niche,
        w.city,
        w.state,
        JSON.stringify(w.keywords),
        JSON.stringify(w.services),
        JSON.stringify(w.areas),
        JSON.stringify(w.blogs),
        w.blueprintId,
        w.stage,
        w.status,
        JSON.stringify(w.brief),
        w.qa ? JSON.stringify(w.qa) : null,
        w.publishedUrl,
        w.disclosure,
      ]
    );
  }

  const j1 = '33333333-3333-4333-8333-333333333301';
  const j2 = '33333333-3333-4333-8333-333333333302';
  const j3 = '33333333-3333-4333-8333-333333333303';
  const j4 = '33333333-3333-4333-8333-333333333304';
  const j5 = '33333333-3333-4333-8333-333333333305';

  const jobs = [
    {
      id: j1,
      websiteId: w1,
      type: 'publish_website',
      status: 'completed',
      pct: 100,
      step: 'Published to edge CDN and verified SSL certificate',
      imgFail: 0,
      err: null,
    },
    {
      id: j2,
      websiteId: w2,
      type: 'publish_website',
      status: 'completed',
      pct: 100,
      step: 'Published to edge CDN and verified canonicals',
      imgFail: 0,
      err: null,
    },
    {
      id: j3,
      websiteId: w3,
      type: 'create_website',
      status: 'completed',
      pct: 100,
      step: 'Build completed; awaiting QA Center resolution',
      imgFail: 0,
      err: null,
    },
    {
      id: j4,
      websiteId: w4,
      type: 'create_website',
      status: 'running',
      pct: 68,
      step: 'Generating geo-localized area pages and compliance footers',
      imgFail: 0,
      err: null,
    },
    {
      id: j5,
      websiteId: w5,
      type: 'create_website',
      status: 'failed',
      pct: 82,
      step: 'Image asset generation stalled on 2 service hero banners',
      imgFail: 2,
      err: 'MCP media worker timeout generating 2 hero illustrations (retry_website_images recommended).',
    },
  ];

  for (const j of jobs) {
    await client.query(
      `INSERT INTO build_jobs (
        id, website_id, job_type, status, progress_pct, current_step,
        image_failures_count, error_message, mcp_mode, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'demo',$9)
      ON CONFLICT (id) DO NOTHING`,
      [
        j.id,
        j.websiteId,
        j.type,
        j.status,
        j.pct,
        j.step,
        j.imgFail,
        j.err,
        j.status === 'completed' || j.status === 'failed' ? new Date().toISOString() : null,
      ]
    );
  }

  const qaRows = [
    // w1 all pass
    { wid: w1, cat: 'seo', key: 'seo_meta', title: 'Title tags, H1 hierarchy & Texas schema markup', status: 'pass', details: 'All 18 pages have unique 50-60 char titles and FinancialProduct / LocalBusiness JSON-LD.', hint: '' },
    { wid: w1, cat: 'content', key: 'content_depth', title: 'Educational content depth & readability', status: 'pass', details: 'Average 1,340 words per guide; zero duplicate boilerplate detected.', hint: '' },
    { wid: w1, cat: 'canonical', key: 'canonical_tags', title: 'Self-referencing canonical URLs', status: 'pass', details: '18/18 pages specify https://lonestarhomeloansedu.com canonical links.', hint: '' },
    { wid: w1, cat: 'disclosure', key: 'loan_disclosure', title: 'US mortgage non-lender & NMLS referral disclosure', status: 'pass', details: 'Above-the-fold disclaimer and /disclosures page verified.', hint: '' },
    { wid: w1, cat: 'image', key: 'image_assets', title: 'Image loading, aspect ratio & alt attributes', status: 'pass', details: '12/12 images resolved with descriptive alt text.', hint: '' },
    { wid: w1, cat: 'link', key: 'link_integrity', title: 'Internal navigation & referral link integrity', status: 'pass', details: '0 broken internal links or orphan pages.', hint: '' },

    // w2 all pass
    { wid: w2, cat: 'seo', key: 'seo_meta', title: 'Title tags & debt consolidation schema', status: 'pass', details: '16/16 pages validated with unique meta descriptions.', hint: '' },
    { wid: w2, cat: 'content', key: 'content_depth', title: 'APR & fee explanation accuracy', status: 'pass', details: 'Includes representative APR range examples without guaranteed approval wording.', hint: '' },
    { wid: w2, cat: 'canonical', key: 'canonical_tags', title: 'Canonical URL consistency', status: 'pass', details: 'HTTPS canonical tags present across all routes.', hint: '' },
    { wid: w2, cat: 'disclosure', key: 'loan_disclosure', title: 'US personal loan advertising & referral disclosure', status: 'pass', details: 'Clear independent publisher & state-variance statement visible.', hint: '' },
    { wid: w2, cat: 'image', key: 'image_assets', title: 'Media asset resolution & alt text', status: 'pass', details: '10/10 images verified.', hint: '' },
    { wid: w2, cat: 'link', key: 'link_integrity', title: 'Internal & outbound referral link check', status: 'pass', details: 'All links return HTTP 200.', hint: '' },

    // w3 has 1 fail (disclosure) and 1 warn (canonical)
    { wid: w3, cat: 'seo', key: 'seo_meta', title: 'SBA & commercial keyword metadata', status: 'pass', details: '20/20 pages have localized Tampa/Florida title and meta tags.', hint: '' },
    { wid: w3, cat: 'content', key: 'content_depth', title: 'SBA 7(a) & 504 educational rigor', status: 'pass', details: 'DSCR formulas and documentation checklists verified.', hint: '' },
    { wid: w3, cat: 'canonical', key: 'canonical_tags', title: 'Staging vs production canonical domain check', status: 'warn', details: '2 area subpages still reference preview subdomain in og:url.', hint: 'Update canonical base to https://sunbeltsbacapitalhub.com before publish.' },
    { wid: w3, cat: 'disclosure', key: 'loan_disclosure', title: 'Commercial financing & SBA affiliation disclaimer', status: 'fail', details: 'Footer missing explicit "Not affiliated with the U.S. Small Business Administration" notice on /sba-7a-guide.', hint: 'Insert standard SBA non-affiliation disclosure block in footer template.' },
    { wid: w3, cat: 'image', key: 'image_assets', title: 'Image integrity & compression', status: 'pass', details: '14/14 images generated and optimized.', hint: '' },
    { wid: w3, cat: 'link', key: 'link_integrity', title: 'Internal anchor & resource link check', status: 'pass', details: '42/42 internal links valid.', hint: '' },
  ];

  for (const q of qaRows) {
    await client.query(
      `INSERT INTO qa_checks (
        id, website_id, category, check_key, title, status, details, auto_fix_hint
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (website_id, check_key) DO NOTHING`,
      [crypto.randomUUID(), q.wid, q.cat, q.key, q.title, q.status, q.details, q.hint]
    );
  }

  const costs = [
    { wid: w1, jid: j1, cat: 'content', model: 'claude-3-7-sonnet', units: 68400, unitLabel: 'tokens', est: 4.15, act: 4.08 },
    { wid: w1, jid: j1, cat: 'image', model: 'flux-1.1-pro', units: 12, unitLabel: 'images', est: 2.40, act: 2.40 },
    { wid: w2, jid: j2, cat: 'content', model: 'claude-3-7-sonnet', units: 60800, unitLabel: 'tokens', est: 3.60, act: 3.72 },
    { wid: w2, jid: j2, cat: 'image', model: 'flux-1.1-pro', units: 10, unitLabel: 'images', est: 2.00, act: 2.00 },
    { wid: w3, jid: j3, cat: 'content', model: 'gpt-4.1', units: 76000, unitLabel: 'tokens', est: 4.85, act: 4.92 },
    { wid: w3, jid: j3, cat: 'image', model: 'flux-1.1-pro', units: 14, unitLabel: 'images', est: 2.80, act: 2.80 },
    { wid: w4, jid: j4, cat: 'content', model: 'claude-3-7-sonnet', units: 39200, unitLabel: 'tokens', est: 3.10, act: 2.15 },
    { wid: w5, jid: j5, cat: 'content', model: 'claude-3-7-sonnet', units: 55100, unitLabel: 'tokens', est: 3.30, act: 3.24 },
    { wid: w5, jid: j5, cat: 'image', model: 'flux-1.1-pro', units: 8, unitLabel: 'images', est: 2.00, act: 1.60 },
  ];

  for (const c of costs) {
    await client.query(
      `INSERT INTO cost_entries (
        id, website_id, job_id, category, provider_model, units, unit_label,
        estimated_cost_usd, actual_cost_usd, is_demo
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
      [
        crypto.randomUUID(),
        c.wid,
        c.jid,
        c.cat,
        c.model,
        c.units,
        c.unitLabel,
        c.est,
        c.act,
      ]
    );
  }
}
