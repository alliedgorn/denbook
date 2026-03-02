import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson } from '../format.ts';

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List documents in the knowledge base')
    .option('-t, --type <type>', 'Filter by type (learning, principle, retro, all)', 'all')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('-o, --offset <n>', 'Skip first N results', '0')
    .option('--no-group', 'Disable grouping by type')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/list', {
        query: {
          type: opts.type,
          limit: opts.limit,
          offset: opts.offset,
          group: opts.group === false ? 'false' : undefined,
        },
      });
      if (opts.json) return printJson(data);

      const docs = data.documents || data.results || [];
      if (docs.length === 0) {
        console.log('No documents found.');
        return;
      }
      console.log(`${data.total || docs.length} document${docs.length !== 1 ? 's' : ''}:\n`);
      for (const d of docs) {
        const project = d.project ? ` [${d.project}]` : '';
        console.log(`  ${d.type || 'doc'}${project}  ${d.source_file || d.id}`);
        if (d.concepts?.length) console.log(`    tags: ${d.concepts.join(', ')}`);
      }
    });
}
