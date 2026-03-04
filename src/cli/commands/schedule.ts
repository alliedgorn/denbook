import type { Command } from 'commander';
import { oracleFetch } from '../http.ts';
import { printJson, printSchedule } from '../format.ts';

export function registerSchedule(program: Command): void {
  const sched = program
    .command('schedule')
    .description('View and manage scheduled events');

  sched
    .command('list')
    .description('List upcoming events')
    .option('-d, --date <date>', 'Filter by date (YYYY-MM-DD)')
    .option('--from <date>', 'Start date')
    .option('--to <date>', 'End date')
    .option('-s, --status <status>', 'Filter by status (pending, done)')
    .option('-l, --limit <n>', 'Max results')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/schedule', {
        query: {
          date: opts.date,
          from: opts.from,
          to: opts.to,
          status: opts.status,
          limit: opts.limit,
        },
      });
      if (opts.json) return printJson(data);
      printSchedule(data.events || data.schedule || [], data.total || 0);
    });

  sched
    .command('add')
    .description('Add a new event')
    .requiredOption('-d, --date <date>', 'Event date (YYYY-MM-DD)')
    .requiredOption('-e, --event <text>', 'Event description')
    .option('-t, --time <time>', 'Event time (HH:MM)')
    .option('-n, --notes <notes>', 'Additional notes')
    .option('-r, --recurring <pattern>', 'Recurrence pattern')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const data = await oracleFetch('/api/schedule', {
        method: 'POST',
        body: {
          date: opts.date,
          event: opts.event,
          time: opts.time,
          notes: opts.notes,
          recurring: opts.recurring,
        },
      });
      if (opts.json) return printJson(data);
      console.log(`Event added: ${opts.event}`);
      if (data.id) console.log(`ID: ${data.id}`);
    });

  // Default action: list
  sched.action(async (opts) => {
    const data = await oracleFetch('/api/schedule');
    if (opts.json) return printJson(data);
    printSchedule(data.events || data.schedule || [], data.total || 0);
  }).option('--json', 'Output raw JSON');
}
