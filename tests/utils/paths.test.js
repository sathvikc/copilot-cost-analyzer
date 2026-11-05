import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('getWorkspaceStoragePaths', () => {
  let tmp, savedEnv, paths;

  const mk = (...segs) => {
    const dir = path.join(tmp, ...segs);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    delete process.env.APPDATA;
    // Fresh module so derivedBase state doesn't leak between tests
    delete require.cache[require.resolve('../../src/utils/paths')];
    paths = require('../../src/utils/paths');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns [] when nothing exists', () => {
    expect(paths.getWorkspaceStoragePaths()).toEqual([]);
  });

  it('returns the derived path when no standard location exists', () => {
    const base = mk('.vscode-server', 'data', 'User', 'workspaceStorage');
    paths.setGlobalStorageBase(path.join(tmp, '.vscode-server/data/User/globalStorage/pub.ext'));
    expect(paths.getWorkspaceStoragePaths()).toEqual([base]);
  });

  it('includes the derived path alongside an existing standard location (remote/tunnel)', () => {
    const standard = mk('.config', 'Code', 'User', 'workspaceStorage');
    const derived = mk('.vscode-server', 'data', 'User', 'workspaceStorage');
    paths.setGlobalStorageBase(path.join(tmp, '.vscode-server/data/User/globalStorage/pub.ext'));
    expect(paths.getWorkspaceStoragePaths()).toEqual([standard, derived]);
  });

  it('does not duplicate when the derived path equals a standard location', () => {
    const standard = mk('.config', 'Code', 'User', 'workspaceStorage');
    paths.setGlobalStorageBase(path.join(tmp, '.config/Code/User/globalStorage/pub.ext/'));
    expect(paths.getWorkspaceStoragePaths()).toEqual([standard]);
  });

  it('ignores a derived path that does not exist on disk', () => {
    const standard = mk('.config', 'Code', 'User', 'workspaceStorage');
    paths.setGlobalStorageBase(path.join(tmp, 'nowhere/User/globalStorage/pub.ext'));
    expect(paths.getWorkspaceStoragePaths()).toEqual([standard]);
  });

  it('findWorkspaceFile searches the derived path too', () => {
    mk('.config', 'Code', 'User', 'workspaceStorage');
    const derived = mk('.vscode-server', 'data', 'User', 'workspaceStorage', 'abc123');
    fs.writeFileSync(path.join(derived, 'workspace.json'), '{}');
    paths.setGlobalStorageBase(path.join(tmp, '.vscode-server/data/User/globalStorage/pub.ext'));
    expect(paths.findWorkspaceFile('abc123', 'workspace.json')).toBe(path.join(derived, 'workspace.json'));
  });
});
