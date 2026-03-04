import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson } from '../format.ts';

export function registerLearn(program: Command): void {
  program
    .command('learn')
    .description('Add a new pattern or learning to the knowledge base')
    .requiredOption('-p, --pattern <text>', 'The pattern/learning to record')
    .option('-s, --source <source>', 'Source attribution')
    .option('-c, --concepts <tags>', 'Comma-separated concept tags')
    .option('--origin <origin>', 'Origin: mother, arthur, volt, human')
    .option('--project <project>', 'Project context (ghq-style path)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const concepts = opts.concepts?.split(',').map((s: string) => s.trim());
      const data = await oracleFetch('/api/learn', {
        method: 'POST',
        body: {
          pattern: opts.pattern,
          source: opts.source,
          concepts,
          origin: opts.origin,
          project: opts.project,
          cwd: process.cwd(),
        },
      });
      if (opts.json) return printJson(data);
      console.log(`Learned: ${data.file || data.source_file}`);
      if (data.id) console.log(`ID:      ${data.id}`);
    });
}
