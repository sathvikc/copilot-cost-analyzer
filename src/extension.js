/**
 * @fileoverview Extension entry point.
 *
 * Registers commands, initializes the database, and manages the webview panel.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { Database } = require('./db/db');
const { fullSync } = require('./db/sync');
const { setGlobalStorageBase } = require('./utils/paths');
const sessionApi = require('./api/sessionApi');
const { createHostRpc } = require('./shared/rpc');

const PANEL_VIEW_TYPE = 'copilotCostAnalyzer.panel';

// Copilot Chat must have file logging enabled for it to write the debug-logs/
// directories this extension reads. When it's off, there are no logs to analyze
// and the panel would otherwise look blank. We surface this setting so users can
// enable it in one click.
const COPILOT_DEBUG_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';

// globalState key: remembers whether the user opted in to viewing estimated
// (chatSessions-derived) sessions, so the choice survives closing the panel.
const ESTIMATED_OPTIN_KEY = 'copilotCostAnalyzer.estimatedOptIn';

let panel = null;
let rpc = null;
let db = null;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('Copilot Cost Analyzer activated');

  try {
    // Initialize database
    const storageDir = context.globalStorageUri.fsPath;
    // Register globalStorage path so workspaceStorage can be derived as a
    // fallback when no standard desktop location exists (e.g. dev containers).
    setGlobalStorageBase(storageDir);
    db = new Database(storageDir);

    // Start DB init + sync in the background; don't block panel opening
    let initDone = false;
    const initPromise = db.init().then(() => {
      initDone = true;
      const config = vscode.workspace.getConfiguration('copilotCostAnalyzer');
      const autoSync = config.get('autoSyncOnStartup', true);
      if (autoSync) {
        return fullSync(db).then(result => {
          if (panel && rpc) {
            rpc.notify('syncComplete', result);
          }
          return result;
        });
      }
      return { synced: 0, skipped: 0, errors: 0 };
    }).catch(err => {
      console.error('[CopilotCostAnalyzer] DB init failed:', err);
      vscode.window.showErrorMessage(`Cost Analyzer DB init failed: ${err.message}`);
      if (panel && rpc) rpc.notify('initError', { message: err.message });
      return { synced: 0, skipped: 0, errors: 1 };
    });

    // Command: open panel (does NOT wait for init/sync)
    const openCmd = vscode.commands.registerCommand(
      'copilotCostAnalyzer.openPanel',
      async () => {
        try {
          await showPanel(context);
          if (!initDone) {
            if (rpc) rpc.notify('loading', { message: 'Initializing...' });
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Open panel failed: ${err.message}`);
        }
      }
    );

    // Command: refresh sessions
    const refreshCmd = vscode.commands.registerCommand(
      'copilotCostAnalyzer.refresh',
      async () => {
        try {
          await initPromise;
          const result = await fullSync(db);
          vscode.window.showInformationMessage(
            `Synced: ${result.synced}, Skipped: ${result.skipped}, Errors: ${result.errors}`
          );
          if (panel && rpc) {
            rpc.notify('syncComplete', result);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
        }
      }
    );

    // Register webview view provider for activity bar
    const viewProvider = new CostAnalyzerViewProvider(context);
    const viewDisposable = vscode.window.registerWebviewViewProvider(
      'copilotCostAnalyzerPanel',
      viewProvider
    );

    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.text = '$(graph) Cost Analyzer';
    statusBarItem.tooltip = 'Open Copilot Cost Analyzer';
    statusBarItem.command = 'copilotCostAnalyzer.openPanel';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(openCmd, refreshCmd, viewDisposable);
  } catch (err) {
    console.error('[CopilotCostAnalyzer] Activation failed:', err);
    vscode.window.showErrorMessage(`Copilot Cost Analyzer activation failed: ${err.message}`);
  }
}

/**
 * Webview view provider for the activity bar panel.
 * Provides a lightweight view that links to the full panel.
 */
class CostAnalyzerViewProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'ui')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'node_modules', 'lume-js', 'dist'))
      ]
    };

    // Open the full panel as a tab when sidebar is activated (fire and forget)
    vscode.commands.executeCommand('copilotCostAnalyzer.openPanel');

    // Keep a minimal welcome UI in the sidebar
    webviewView.webview.html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; padding:20px; font-family:var(--vscode-font-family); color:var(--vscode-foreground); text-align:center; }
  h1 { font-size:14px; margin-bottom:8px; }
  p { font-size:12px; opacity:0.7; }
</style></head>
<body>
  <h1>Copilot Cost Analyzer</h1>
  <p>Panel opened in a tab.</p>
  <p>Click the icon again to bring it to focus.</p>
</body>
</html>`;

    // Sidebar has no <script>; all interaction happens in the full panel.
    // This provider only shows a static welcome message.
  }
}

/**
 * Create or reveal the webview panel.
 * @param {vscode.ExtensionContext} context
 */
async function showPanel(context) {
  const autoSync = vscode.workspace.getConfiguration('copilotCostAnalyzer').get('autoSyncOnStartup', true);
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    if (autoSync) runSyncAndNotify().catch(() => {});
    return;
  }

  panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    'Copilot Cost Analyzer',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'src', 'ui')),
        vscode.Uri.file(path.join(context.extensionPath, 'assets', 'icons')),
        vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'lume-js', 'dist'))
      ]
    }
  );

  panel.webview.html = getWebviewContent(panel.webview, context);

  // --- RPC layer: typed request/response handlers ---
  rpc = createHostRpc(panel.webview);

  // If sync is already running when the panel opens, notify it immediately
  if (_syncInProgress) rpc.notify('syncStart');
  rpc.handle('getSessions', () => {
    if (!db) return [];
    return sessionApi.getSessions(db);
  });
  rpc.handle('getSessionDetail', ({ sessionId }) => {
    if (!db) return { session: null, turns: [], llmCalls: [], toolCalls: [], userMessages: [], modelSwitches: [], toolLeaderboard: [] };
    return sessionApi.getSessionDetail(db, sessionId);
  });
  rpc.handle('getDashboard', () => {
    if (!db) return { dailyCost: [], toolsBySession: [], modelsBySession: [] };
    return sessionApi.getDashboard(db);
  });
  rpc.handle('getModelCatalog', () => {
    if (!db) return [];
    return sessionApi.getModelCatalog(db);
  });
  rpc.handle('getAgentResponses', ({ sessionId }) => {
    if (!db) return [];
    return sessionApi.getAgentResponses(db, sessionId);
  });
  rpc.handle('getCacheBreakSummary', ({ sessionId }) => {
    if (!db) return { total: 0, byType: {}, breaks: [] };
    return sessionApi.getCacheBreakSummary(db, sessionId);
  });
  rpc.handle('getDiscoveryEvents', ({ sessionId }) => {
    if (!db) return [];
    return sessionApi.getDiscoveryEvents(db, sessionId);
  });
  rpc.handle('getTranscripts', ({ sessionId }) => {
    if (!db) return [];
    return sessionApi.getTranscripts(db, sessionId);
  });
  rpc.handle('getConversation', ({ sessionId }) => {
    if (!db) return [];
    return sessionApi.getConversation(db, sessionId);
  });
  rpc.handle('exportSession', ({ sessionId, format, options }) => {
    if (!db) return { data: '', mimeType: 'application/json', filename: 'empty.json' };
    return sessionApi.exportSession(db, sessionId, { format, ...options });
  });
  rpc.handle('triggerSync', async () => {
    await runSyncAndNotify({ manual: true });
    return { ok: true };
  });
  rpc.handle('revealChatSession', async ({ sessionId }) => {
    try {
      // Construct the vscode-chat-session URI (same format as VS Code's LocalChatSessionUri.forSession)
      const encoded = Buffer.from(sessionId).toString('base64url').replace(/=+$/, '');
      const uri = vscode.Uri.from({ scheme: 'vscode-chat-session', authority: 'local', path: '/' + encoded });
      // Note: The vscode-chat-session scheme is registered as a chat editor in VS Code,
      // so vscode.open always opens in the editor area. The sidebar loadSession() API
      // is internal-only and not accessible from extensions.
      await vscode.commands.executeCommand('vscode.open', uri);
      return { opened: true };
    } catch (err) {
      console.warn('[ext] revealChatSession failed:', err.message);
      vscode.window.showWarningMessage('Could not reveal chat session: ' + err.message);
      return { opened: false, error: err.message };
    }
  });
  rpc.handle('openDebugLog', async ({ filePath }) => {
    if (filePath && fs.existsSync(filePath)) {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: true });
      return { opened: true };
    }
    if (filePath) vscode.window.showWarningMessage('Debug log not found: ' + filePath);
    return { opened: false };
  });
  rpc.handle('showNotification', ({ text, level }) => {
    if (level === 'error') {
      vscode.window.showErrorMessage(text);
    } else {
      vscode.window.showInformationMessage(text);
    }
    return { ok: true };
  });
  rpc.handle('getSetupStatus', () => ({
    debugLoggingEnabled: isCopilotDebugLoggingEnabled(),
    settingId: COPILOT_DEBUG_SETTING,
    // Persisted Option B opt-in: once the user chooses "view estimated sessions",
    // remember it so reopening the panel lands on the dashboard, not the notice.
    estimatedOptIn: context.globalState.get(ESTIMATED_OPTIN_KEY, false)
  }));
  rpc.handle('setEstimatedOptIn', ({ value }) => {
    context.globalState.update(ESTIMATED_OPTIN_KEY, !!value);
    return { ok: true };
  });
  rpc.handle('openCopilotDebugSetting', async () => {
    try {
      // Passing the setting id opens the Settings UI filtered to exactly that
      // setting, so the user lands on the toggle directly.
      await vscode.commands.executeCommand('workbench.action.openSettings', COPILOT_DEBUG_SETTING);
      return { opened: true };
    } catch (err) {
      console.warn('[ext] openCopilotDebugSetting failed:', err.message);
      vscode.window.showWarningMessage('Could not open settings: ' + err.message);
      return { opened: false, error: err.message };
    }
  });

  // Sync in background to catch any new sessions
  if (autoSync) runSyncAndNotify().catch(() => {});

  panel.onDidDispose(() => {
    if (rpc) { rpc.dispose(); rpc = null; }
    panel = null;
  });
}

/**
 * Run sync and notify the webview with results.
 * @param {{ manual?: boolean }} [options]
 */
let _syncInProgress = false;
async function runSyncAndNotify({ manual = false } = {}) {
  if (!db || _syncInProgress) return;
  _syncInProgress = true;
  if (panel && rpc) rpc.notify('syncStart');
  try {
    const result = await fullSync(db);
    if (panel && rpc) {
      rpc.notify('syncComplete', result);
    }
    let msg;
    if (result.synced > 0 && result.errors > 0) {
      msg = `Synced ${result.synced} session${result.synced === 1 ? '' : 's'}, ${result.errors} error${result.errors === 1 ? '' : 's'}`;
    } else if (result.synced > 0) {
      msg = `Synced ${result.synced} new session${result.synced === 1 ? '' : 's'}`;
    } else if (result.errors > 0) {
      msg = `Sync completed with ${result.errors} error${result.errors === 1 ? '' : 's'}`;
    } else {
      msg = 'Everything is up to date';
    }
    if (manual || result.synced > 0 || result.errors > 0) {
      vscode.window.showInformationMessage(`Copilot Cost Analyzer — ${msg}`);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
  } finally {
    _syncInProgress = false;
  }
}

/**
 * Check if debug logging is enabled via VS Code settings.
 * @returns {boolean}
 */
function isDebugEnabled() {
  const config = vscode.workspace.getConfiguration('copilotCostAnalyzer');
  return config.get('debugLogging', false);
}

/**
 * Check whether Copilot Chat's debug file logging is enabled. When it is off,
 * Copilot never writes the debug-logs/ this extension parses, so the panel has
 * no data to show. Returns false if the setting is missing (e.g. Copilot Chat
 * not installed) or unreadable.
 * @returns {boolean}
 */
function isCopilotDebugLoggingEnabled() {
  try {
    return vscode.workspace
      .getConfiguration('github.copilot.chat')
      .get('agentDebugLog.fileLogging.enabled') === true;
  } catch {
    return false;
  }
}

/**
 * Build the HTML content for the webview.
 * @param {vscode.Webview} webview
 * @param {vscode.ExtensionContext} context
 * @returns {string}
 */
function getWebviewContent(webview, context) {
  const uiPath = path.join(context.extensionPath, 'src', 'ui');
  const htmlPath = path.join(uiPath, 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf-8');
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(uiPath, 'styles.css')));
    html = html.replace('styles.css', cssUri.toString());
    // Replace app.js entry point with webview URI
    const appUri = webview.asWebviewUri(vscode.Uri.file(path.join(uiPath, 'app.js')));
    html = html.replace('./app.js', appUri.toString());
    // Use the real extension logo for the setup notice instead of an emoji.
    // icon.png (not the .svg) is what ships in the vsix — see .vscodeignore.
    const iconUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets', 'icons', 'icon.png')));
    html = html.replace(/\{\{iconUri\}\}/g, iconUri.toString());
    // Apply Content Security Policy using VS Code's webview nonce
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    // Inject debug flag and lume.js URI for the ESM entry point
    const lumeUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'lume-js', 'dist', 'index.min.mjs')));
    const debugFlag = isDebugEnabled() ? 'true' : 'false';
    html = html.replace(
      '<script type="module"',
      `<script>window.__DEBUG__ = ${debugFlag}; window.__LUME_URI__ = '${lumeUri}';</script>\n    <script type="module"`
    );
    return html;
  }

  // Fallback if files don't exist yet
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Copilot Cost Analyzer</title></head>
<body><h1>Loading...</h1><p>Webview files not found. Please ensure the extension is built correctly.</p></body>
</html>`;
}

function deactivate() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { activate, deactivate };
