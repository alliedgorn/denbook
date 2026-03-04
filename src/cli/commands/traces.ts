import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson, printTraces } from '../format.ts';

export function registerTraces(program: Command): void {
  program
    .command('traces')
    .description('List discovery traces')
    .option('-q, --query <query>', 'Search traces')
    .option('-s, --status <status>', 'Filter by status (raw, reviewed, distilled)')
    .option('-p, --project <project>', 'Filter by project')
    .option('-l, --limit <n>', 'Max results', '50')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/traces', {
        query: {
          query: opts.query,
          status: opts.status,
          project: opts.project,
          limit: opts.limit,
        },
      });
      if (opts.json) return printJson(data);
      printTraces(data.traces || [], data.total || 0);
    });

  program
    .command('trace <id>')
    .description('View a specific trace')
    .option('--json', 'Output raw JSON')
    .action(async (id, opts) => {
      const data = await oracleFetch(`/api/traces/${id}`);
      if (opts.json) return printJson(data);
      printJson(data); // Traces are complex, JSON is most useful
    });
}
