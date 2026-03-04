import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson } from '../format.ts';

export function registerStats(program: Command): void {
  program
    .command('stats')
    .description('Show knowledge base statistics')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/stats');
      if (opts.json) return printJson(data);

      console.log('Oracle Knowledge Base Stats\n');
      if (data.total !== undefined) console.log(`  Total documents: ${data.total}`);
      if (data.byType) {
        console.log('  By type:');
        for (const [type, count] of Object.entries(data.byType)) {
          console.log(`    ${type}: ${count}`);
        }
      }
      if (data.vector) {
        console.log(`  Vector: ${data.vector.enabled ? `${data.vector.count} embeddings` : 'disabled'}`);
      }
      if (data.vault_repo) console.log(`  Vault: ${data.vault_repo}`);
      if (data.lastIndexed) console.log(`  Last indexed: ${new Date(data.lastIndexed).toISOString()}`);
    });
}
