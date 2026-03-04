import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson, printInbox } from '../format.ts';

export function registerInbox(program: Command): void {
  program
    .command('inbox')
    .description('View handoff inbox')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('-t, --type <type>', 'Filter by type (handoff, all)', 'all')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/inbox', {
        query: {
          limit: opts.limit,
          type: opts.type,
        },
      });
      if (opts.json) return printJson(data);
      printInbox(data.files || [], data.total || 0);
    });
}
