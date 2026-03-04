/**
 * Unit tests for detectProject() — ghq-based project detection.
 *
 * Covers: GitHub paths, GitLab paths, nested subdirectories,
 * non-ghq paths, undefined input, and case normalisation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mock } from 'bun:test';
import fs from 'fs';
import { detectProject } from '../project-detect.ts';

// Mock fs.realpathSync to return input path directly (no symlinks in tests)
const originalRealpathSync = fs.realpathSync;

beforeEach(() => {
  fs.realpathSync = ((p: string) => p) as typeof fs.realpathSync;
});

afterEach(() => {
  fs.realpathSync = originalRealpathSync;
});

// ============================================================================
// ghq GitHub paths
// ============================================================================

describe('detectProject — GitHub paths', () => {
  it('should detect project from ghq GitHub path', () => {
    expect(detectProject('/Users/nat/Code/github.com/owner/repo/src')).toBe(
      'github.com/owner/repo',
    );
  });

  it('should detect project from GitHub root (no trailing subdir)', () => {
    expect(detectProject('/Users/nat/Code/github.com/owner/repo')).toBe(
      'github.com/owner/repo',
    );
  });
});

// ============================================================================
// ghq GitLab paths
// ============================================================================

describe('detectProject — GitLab paths', () => {
  it('should detect project from ghq GitLab path', () => {
    expect(detectProject('/Users/nat/Code/gitlab.com/owner/repo')).toBe(
      'gitlab.com/owner/repo',
    );
  });
});

// ============================================================================
// Nested subdirectories
// ============================================================================

describe('detectProject — nested subdirectories', () => {
  it('should extract project from deep nested path', () => {
    expect(
      detectProject('/Users/nat/Code/github.com/org/project/src/deep/path'),
    ).toBe('github.com/org/project');
  });

  it('should not include extra path segments beyond owner/repo', () => {
    const result = detectProject(
      '/Users/nat/Code/github.com/org/project/packages/core/lib',
    );
    expect(result).toBe('github.com/org/project');
  });
});

// ============================================================================
// Non-ghq paths
// ============================================================================

describe('detectProject — non-ghq paths', () => {
  it('should return null for /tmp paths', () => {
    // Restore real realpathSync for this test since /tmp may resolve to
    // a different path on macOS (/private/tmp), and we need the mock to
    // return a path that does NOT match any ghq patterns.
    fs.realpathSync = ((_p: string) => '/tmp/random/path') as typeof fs.realpathSync;
    expect(detectProject('/tmp/random/path')).toBeNull();
  });

  it('should return null for paths without host/owner/repo structure', () => {
    fs.realpathSync = ((_p: string) => '/usr/local/bin') as typeof fs.realpathSync;
    expect(detectProject('/usr/local/bin')).toBeNull();
  });
});

// ============================================================================
// Undefined input
// ============================================================================

describe('detectProject — undefined input', () => {
  it('should return null when cwd is undefined', () => {
    expect(detectProject(undefined)).toBeNull();
  });

  it('should return null when cwd is empty string', () => {
    // Empty string is falsy in JS, so detectProject returns null immediately
    expect(detectProject('')).toBeNull();
  });
});

// ============================================================================
// Case normalisation
// ============================================================================

describe('detectProject — case normalisation', () => {
  it('should normalise output to lowercase', () => {
    expect(detectProject('/Users/nat/Code/github.com/Owner/Repo/src')).toBe(
      'github.com/owner/repo',
    );
  });

  it('should normalise mixed-case host and owner', () => {
    expect(detectProject('/Users/nat/Code/GitHub.COM/MyOrg/MyRepo')).toBe(
      'github.com/myorg/myrepo',
    );
  });
});
