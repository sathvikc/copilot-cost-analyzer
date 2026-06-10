/**
 * Test session API with real DB data.
 * Run: node tests/api/test-session-api.js
 */
const path = require('path');
const { getSessionDetail, getSessions } = require('../../src/api/sessionApi');
const { Database } = require('../../src/db/db');

async function main() {
  const db = new Database(path.join(
    process.env.HOME,
    'Library/Application Support/Code/User/globalStorage/SathvikCheela.copilot-cost-analyzer'
  ));
  await db.init();

  const sessions = getSessions(db);
  if (!sessions.length) {
    console.log('No sessions in DB. Run VS Code extension first to sync.');
    process.exit(0);
  }

  console.log(`Found ${sessions.length} sessions. Testing first one...\n`);
  const sessionId = sessions[0].session_id;

  const detail = getSessionDetail(db, sessionId);

  console.log('=== Session ===');
  console.log(`  ID: ${detail.session?.session_id?.slice(0, 8)}...`);
  console.log(`  Title: ${detail.session?.title?.slice(0, 50) || '(none)'}`);

  console.log(`\n=== Turns (${detail.turns.length}) ===`);
  for (const turn of detail.turns) {
    const msgCount = turn.userMessages.length;
    const toolCount = turn.toolCalls.length;
    const callCount = turn.llmCalls.length;
    console.log(`\n  Turn ${turn.turnNumber}: ${msgCount} msg(s), ${toolCount} tool(s), ${callCount} LLM call(s)`);
    console.log(`    AIC: ${turn.aicBadge || '—'}  class: ${turn.aicClass || 'none'}`);
    if (turn.userMessages.length > 0) {
      for (const m of turn.userMessages) {
        console.log(`    👤 "${m.content.slice(0, 80)}"`);
      }
    }
    if (turn.toolNames) {
      console.log(`    🔧 ${turn.toolNames}`);
    }
    for (const call of turn.llmCalls) {
      console.log(`    🤖 ${call.model}  in=${call.input_tokens}  out=${call.output_tokens}  aic=${(call.aic/1e9).toFixed(2)}`);
    }
  }

  console.log(`\n=== Raw arrays (for comparison) ===`);
  console.log(`  llmCalls: ${detail.llmCalls.length}`);
  console.log(`  toolCalls: ${detail.toolCalls.length}`);
  console.log(`  userMessages: ${detail.userMessages.length}`);

  // Validate: total messages across turns should equal raw userMessages
  const totalTurnMsgs = detail.turns.reduce((s, t) => s + t.userMessages.length, 0);
  console.log(`\n=== Validation ===`);
  console.log(`  Total messages in turns: ${totalTurnMsgs}`);
  console.log(`  Raw userMessages: ${detail.userMessages.length}`);
  console.log(`  Match: ${totalTurnMsgs === detail.userMessages.length ? 'YES ✓' : 'NO ✗'}`);

  db.close();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
