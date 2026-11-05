/**
 * @fileoverview Cross-platform VS Code workspace storage path resolution.
 *
 * Single source of truth for finding VS Code data directories across
 * macOS, Windows, and Linux (both Stable and Insiders builds).
 */

const fs = require('fs');
const path = require('path');

/**
 * workspaceStorage base derived from the extension's own globalStorage path.
 * Covers installs where data lives outside the standard desktop locations
 * (e.g. VS Code Server in a dev container, SSH/tunnel remote, or a custom
 * --user-data-dir), such as ~/.vscode-server/data/User/workspaceStorage.
 * @type {string|null}
 */
let derivedBase = null;

/**
 * Register the extension's globalStorage path so a fallback workspaceStorage
 * location can be derived from it. VS Code always keeps `globalStorage` and
 * `workspaceStorage` as siblings under the same `User/` directory, so going up
 * two levels and into `workspaceStorage` lands on the correct folder regardless
 * of OS or whether we're running in a container / remote.
 *
 * Call once at extension activation with `context.globalStorageUri.fsPath`.
 * @param {string} globalStorageFsPath
 */
function setGlobalStorageBase(globalStorageFsPath) {
  if (globalStorageFsPath) {
    derivedBase = path.join(path.dirname(path.dirname(globalStorageFsPath)), 'workspaceStorage');
  }
}

/**
 * Get all valid VS Code workspace storage base paths for the current platform.
 * Returns paths that actually exist on disk (may be 0, 1, or multiple if both
 * Stable and Insiders are installed).
 *
 * The location derived via setGlobalStorageBase() is always included when it
 * exists, in addition to the hardcoded desktop candidates. On remote hosts
 * (Remote-SSH, dev tunnels, WSL, dev containers) the real data lives under
 * ~/.vscode-server/... or ~/.vscode/cli/..., and a standard-looking desktop
 * directory may also be present, so it can't be treated as a mutually
 * exclusive fallback. Duplicates are removed.
 * @returns {string[]}
 */
function getWorkspaceStoragePaths() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const appdata = process.env.APPDATA;
  const candidates = [
    path.join(home, 'Library/Application Support/Code/User/workspaceStorage'),           // macOS
    path.join(home, 'Library/Application Support/Code - Insiders/User/workspaceStorage'), // macOS Insiders
    ...(appdata ? [
      path.join(appdata, 'Code/User/workspaceStorage'),                                   // Windows
      path.join(appdata, 'Code - Insiders/User/workspaceStorage'),                        // Windows Insiders
    ] : []),
    path.join(home, '.config/Code/User/workspaceStorage'),                                 // Linux
    path.join(home, '.config/Code - Insiders/User/workspaceStorage'),                      // Linux Insiders
    ...(derivedBase ? [derivedBase] : []),                                                 // Remote / dev container / custom user-data-dir
  ];

  const seen = new Set();
  return candidates.filter(p => {
    const key = path.resolve(p);
    if (seen.has(key) || !fs.existsSync(p)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Find a file relative to a workspace hash directory across all VS Code installations.
 * @param {string} workspaceHash
 * @param {...string} relativeSegments - Path segments relative to the workspace dir
 * @returns {string|null} Absolute path to the file, or null if not found
 */
function findWorkspaceFile(workspaceHash, ...relativeSegments) {
  const bases = getWorkspaceStoragePaths();
  for (const base of bases) {
    const filePath = path.join(base, workspaceHash, ...relativeSegments);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

module.exports = { getWorkspaceStoragePaths, findWorkspaceFile, setGlobalStorageBase };
