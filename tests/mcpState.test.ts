import assert from 'node:assert/strict';
import test from 'node:test';
import { readRemoteBrief, readRemoteBuild } from '../src/server/mcpState.ts';

test('recognizes LocalSites.pro generated site after nested build reaches done', () => {
  const result = readRemoteBuild({
    status: 'deployed',
    live_url: 'https://example.pages.dev',
    build: {
      state: 'done',
      steps_done: '12/12',
      progress: { deploy: 'done', images: 'failed (Insufficient credits)' },
      cost_usd: 0.061652,
    },
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.progressPct, 100);
  assert.equal(result.liveUrl, 'https://example.pages.dev');
  assert.match(result.imageFailure || '', /Insufficient credits/);
  assert.equal(result.costUsd, 0.061652);
});

test('does not complete asynchronous deployment prematurely', () => {
  const result = readRemoteBuild({
    status: 'deploying',
    build: { state: 'running', steps_done: '2/3', progress: { deploy: 'finalizing deployment' } },
  });
  assert.equal(result.state, 'running');
  assert.equal(result.progressPct, 67);
});

test('detects remote errors', () => {
  const result = readRemoteBuild({
    status: 'failed',
    build: { state: 'failed', error: 'Cloudflare denied request' },
  });
  assert.equal(result.state, 'failed');
  assert.match(result.error || '', /Cloudflare/);
});

test('extracts real page counts from LocalSites.pro dry-run brief', () => {
  const brief = readRemoteBrief({
    dry_run: true,
    brief: {
      pages: {
        home: 1,
        services: '2 (Personal Loan Education, Repayment Planning)',
        areas: '2 (Mid-City, Gentilly)',
        blogs: 1,
        other: 'about, contact, privacy, terms, accessibility',
      },
    },
    missing_business_facts: ['phone', 'email'],
  });
  assert.equal(brief.pages, 11);
  assert.equal(brief.warnings.length, 2);
});

test('does not treat deployed but still running build as complete', () => {
  const result = readRemoteBuild({
    status: 'deployed',
    build: { state: 'running', steps_done: '2/3' },
  });
  assert.equal(result.state, 'running');
});
