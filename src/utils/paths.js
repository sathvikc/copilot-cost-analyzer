/**
 * @fileoverview Cross-platform VS Code workspace storage path resolution.
 *
 * Single source of truth for finding VS Code data directories across
 * macOS, Windows, and Linux (both Stable and Insiders builds).
 */

const fs = require('fs');
const path = require('path');

/**
 * Get all valid VS Code workspace storage base paths for the current platform.
 * Returns paths that actually exist on disk (may be 0, 1, or multiple if both
 * Stable and Insiders are installed).
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
  ];
  return candidates.filter(p => fs.existsSync(p));
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

module.exports = { getWorkspaceStoragePaths, findWorkspaceFile };
