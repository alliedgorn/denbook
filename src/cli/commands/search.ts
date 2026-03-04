import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson, printSearchResults } from '../format.ts';

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Search Oracle knowledge base')
    .option('-t, --type <type>', 'Filter by document type (learning, principle, retro, all)', 'all')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('-m, --mode <mode>', 'Search mode: hybrid, fts, vector', 'hybrid')
    .option('-p, --project <project>', 'Filter by project')
    .option('--json', 'Output raw JSON')
    .action(async (query, opts) => {
      const data = await oracleFetch('/api/search', {
        query: {
          q: query,
          type: opts.type,
          limit: opts.limit,
          mode: opts.mode,
          project: opts.project,
          cwd: process.cwd(),
        },
      });
      if (opts.json) return printJson(data);
      printSearchResults(data.results || [], data.total || 0);
    });
}
