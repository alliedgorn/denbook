import type { Command } from 'commander';
import { ensureServerRunning, getServerStatus } from '../../ensure-server.ts';
import { readPidFile, isProcessAlive } from '../../process-manager/index.ts';
import { httpShutdown, waitForPortFree } from '../../process-manager/HealthMonitor.ts';
import { printJson } from '../format.ts';
import { PORT } from '../../config.ts';

export function registerServer(program: Command): void {
  const srv = program
    .command('server')
    .description('Manage Oracle HTTP server');

  srv
    .command('start')
    .description('Start the Oracle server')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const ok = await ensureServerRunning({ verbose: true, timeout: 15000 });
      if (opts.json) return printJson({ started: ok, port: PORT, url: `http://localhost:${PORT}` });
      if (!ok) {
        console.error('Failed to start Oracle server.');
        process.exit(1);
      }
    });

  srv
    .command('stop')
    .description('Stop the Oracle server')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const pidInfo = readPidFile();
      if (!pidInfo || !isProcessAlive(pidInfo.pid)) {
        if (opts.json) return printJson({ stopped: true, was_running: false });
        console.log('Oracle server is not running.');
        return;
      }

      const shutdownOk = await httpShutdown(PORT, {
        baseUrl: 'http://127.0.0.1',
        shutdownPath: '/api/shutdown',
      });

      if (!shutdownOk) {
        // Fallback: SIGTERM
        try {
          process.kill(pidInfo.pid, 'SIGTERM');
        } catch {
          // Already dead
        }
      }

      const portFree = await waitForPortFree(PORT, 5000);
      if (opts.json) return printJson({ stopped: portFree, pid: pidInfo.pid });
      if (portFree) {
        console.log(`Oracle server stopped (PID ${pidInfo.pid}).`);
      } else {
        console.error(`Server may still be running on port ${PORT}.`);
        process.exit(1);
      }
    });

  srv
    .command('status')
    .description('Show Oracle server status')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const status = await getServerStatus();
      if (opts.json) return printJson(status);
      console.log(`Running:  ${status.running ? 'yes' : 'no'}`);
      if (status.pid) console.log(`PID:      ${status.pid}`);
      console.log(`Port:     ${status.port}`);
      console.log(`Healthy:  ${status.healthy ? 'yes' : 'no'}`);
      console.log(`URL:      ${status.url}`);
    });

  // Default action: status
  srv.action(async (opts) => {
    const status = await getServerStatus();
    if (opts.json) return printJson(status);
    console.log(`Running:  ${status.running ? 'yes' : 'no'}`);
    if (status.pid) console.log(`PID:      ${status.pid}`);
    console.log(`Port:     ${status.port}`);
    console.log(`Healthy:  ${status.healthy ? 'yes' : 'no'}`);
    console.log(`URL:      ${status.url}`);
  }).option('--json', 'Output raw JSON');
}
