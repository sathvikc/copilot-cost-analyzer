/**
 * @fileoverview Regression test for AIC cost overwrite bug.
 *
 * Verifies that sync.js keeps total_cost (token pricing) and
 * computed_cost (AIC-based) as independent values in the DB.
 *
 * Bug: sync.js was overwriting totalCost with totalAic / 1e11
 * when AIC data existed, losing the token-based cost.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { syncSession } = require('../../src/db/sync');

describe('syncSession — AIC cost independence', () => {
  let db;
  let tmpDir;
  let dbDir;

  beforeEach(async () => {
    // Temp dir for mock debug logs
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-sync-test-'));
    // Separate temp dir for DB
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-db-test-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('total_cost remains token-based when AIC data exists', async () => {
    // Create models.json with known pricing
    // Format: input_price/cache_price/output_price in attocents*10000
    // 200 → $0.02/1M, 50 → $0.005/1M, 800 → $0.08/1M
    const modelsJson = [
      {
        id: 'gpt-test',
        display_name: 'GPT Test',
        billing: {
          token_prices: {
            default: {
              input_price: 200,
              cache_price: 50,
              output_price: 800,
              context_max: 128000
            }
          }
        }
      }
    ];
    fs.writeFileSync(path.join(tmpDir, 'models.json'), JSON.stringify(modelsJson));

    // Create main.jsonl with one LLM call that has BOTH token data AND AIC
    // Token cost: freshInput=2000*0.02/1e6 + cached=8000*0.005/1e6 + output=500*0.08/1e6
    //           = 0.00004 + 0.00004 + 0.00004 = 0.00012
    // AIC cost:  5e9 / 1e11 = 0.05
    const AIC_VALUE = 5e9; // 5 nano-AIU billion = 50 credits
    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'test prompt' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'llm_request',
        status: 'ok',
        ts: '2026-01-01T00:00:01Z',
        attrs: {
          model: 'gpt-test',
          inputTokens: 10000,
          outputTokens: 500,
          cachedTokens: 8000,
          copilotUsageNanoAiu: AIC_VALUE
        }
      })
    ];
    fs.writeFileSync(path.join(tmpDir, 'main.jsonl'), lines.join('\n'));

    // Run sync
    const sessionInfo = {
      sessionId: 'regression-aic-cost-001',
      workspaceHash: 'fakehash',
      workspacePath: '/fake/workspace',
      debugLogPath: tmpDir,
      mainJsonlMtime: Date.now()
    };

    const didSync = await syncSession(db, sessionInfo, 0);
    expect(didSync).toBe(true);

    // Read back from DB
    const row = db.queryOne(
      'SELECT total_cost, total_aic, computed_cost FROM sessions WHERE session_id = $sid',
      { $sid: 'regression-aic-cost-001' }
    );

    expect(row).not.toBeNull();

    // total_aic should be the raw AIC value
    expect(row.total_aic).toBe(AIC_VALUE);

    // computed_cost should be AIC-based: 5e9 / 1e11 = 0.05
    const expectedAicCost = AIC_VALUE / 1e11;
    expect(row.computed_cost).toBeCloseTo(expectedAicCost, 6);

    // REGRESSION: total_cost MUST be token-based pricing, NOT the AIC cost
    // Token cost = 0.00012 (see calculation above)
    const expectedTokenCost = 0.00012;
    expect(row.total_cost).toBeCloseTo(expectedTokenCost, 6);

    // They must be different values
    expect(row.total_cost).not.toBeCloseTo(row.computed_cost, 4);
  });
});
