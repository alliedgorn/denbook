import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson, printThreads, printThread } from '../format.ts';

export function registerThreads(program: Command): void {
  program
    .command('threads')
    .description('List discussion threads')
    .option('-s, --status <status>', 'Filter by status (open, closed)')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/threads', {
        query: {
          status: opts.status,
          limit: opts.limit,
        },
      });
      if (opts.json) return printJson(data);
      printThreads(data.threads || [], data.total || 0);
    });

  program
    .command('thread <id>')
    .description('View a thread and its messages')
    .option('--json', 'Output raw JSON')
    .action(async (id, opts) => {
      const data = await oracleFetch(`/api/thread/${id}`);
      if (opts.json) return printJson(data);
      printThread(data.thread, data.messages || []);
    });
}
