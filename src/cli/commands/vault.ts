import type { Command } from 'commander';
import { initVault, syncVault, pullVault, vaultStatus } from '../../vault/handler.ts';
import { findPsiRepos, migrate } from '../../vault/migrate.ts';
import { detectProject } from '../../server/project-detect.ts';
import { printJson } from '../format.ts';
import path from 'path';
import fs from 'fs';

export function registerVault(program: Command): void {
  const vault = program
    .command('vault')
    .description('Manage Oracle knowledge vault');

  const repoRoot = process.env.ORACLE_REPO_ROOT || process.cwd();

  vault
    .command('init <repo>')
    .description('Initialize vault with a GitHub repo (owner/repo)')
    .option('--json', 'Output raw JSON')
    .action(async (repo, opts) => {
      const result = initVault(repo);
      if (opts.json) return printJson(result);
      console.log(JSON.stringify(result, null, 2));
    });

  vault
    .command('sync')
    .description('Commit + push vault repo to GitHub (backup)')
    .option('--dry-run', 'Preview what would be committed')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const result = syncVault({ dryRun: opts.dryRun, repoRoot });
      if (opts.json) return printJson(result);
      console.log(JSON.stringify(result, null, 2));
    });

  vault
    .command('pull')
    .description('Pull vault files into the local psi directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const result = pullVault({ repoRoot });
      if (opts.json) return printJson(result);
      console.log(JSON.stringify(result, null, 2));
    });

  vault
    .command('status')
    .description('Show vault configuration and pending changes')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const result = vaultStatus(repoRoot);
      if (opts.json) return printJson(result);
      console.log(`Vault: ${result.enabled ? 'enabled' : 'disabled'}`);
      if (result.repo) console.log(`Repo:  ${result.repo}`);
      if (result.vaultPath) console.log(`Path:  ${result.vaultPath}`);
      if (result.lastSync) console.log(`Last sync: ${result.lastSync}`);
      if (result.pending && result.pending.total > 0) {
        console.log(`\nPending changes: ${result.pending.total}`);
        console.log(`  Added: ${result.pending.added}  Modified: ${result.pending.modified}  Deleted: ${result.pending.deleted}`);
      }
    });

  vault
    .command('migrate')
    .description('Seed vault repo from all ghq repos with psi directories')
    .option('--dry-run', 'Preview what would be copied')
    .option('--list', 'List repos with psi directories')
    .option('--symlink', 'Replace local psi with symlink to vault')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.list) {
        const repos = findPsiRepos();
        console.log(`Found ${repos.length} repos with psi directories:\n`);
        for (const { repoPath, psiDir } of repos) {
          const project = detectProject(repoPath) ?? '(unknown)';
          const isSymlink = fs.lstatSync(psiDir).isSymbolicLink();
          if (isSymlink) {
            console.log(`  ${project} symlinked`);
          } else {
            let count = 0;
            const walk = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              for (const item of fs.readdirSync(dir)) {
                const full = path.join(dir, item);
                const stat = fs.lstatSync(full);
                if (stat.isSymbolicLink()) continue;
                if (stat.isDirectory()) walk(full);
                else count++;
              }
            };
            walk(psiDir);
            console.log(`  ${project} (${count} files) local`);
          }
          console.log(`    ${repoPath}`);
        }
        return;
      }

      if (opts.dryRun) console.error('[Vault] DRY RUN — no files will be copied\n');
      if (opts.symlink) console.error('[Vault] SYMLINK MODE — local psi will be replaced with symlinks\n');
      const result = migrate({ dryRun: opts.dryRun, symlink: opts.symlink });
      if (opts.json) return printJson(result);
      console.log(JSON.stringify(result, null, 2));
    });

  // Default action: status
  vault.action(async (opts) => {
    const result = vaultStatus(repoRoot);
    if (opts.json) return printJson(result);
    console.log(`Vault: ${result.enabled ? 'enabled' : 'disabled'}`);
    if (result.repo) console.log(`Repo:  ${result.repo}`);
    if (result.vaultPath) console.log(`Path:  ${result.vaultPath}`);
  }).option('--json', 'Output raw JSON');
}
