/**
 * Terminal output formatting for Oracle CLI
 */

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

export function printSearchResults(results: any[], total: number): void {
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }
  console.log(`Found ${total} result${total !== 1 ? 's' : ''}:\n`);
  for (const r of results) {
    const score = r.score != null ? ` (${(r.score * 100).toFixed(0)}%)` : '';
    const project = r.project ? ` [${r.project}]` : '';
    const type = r.type ? `${r.type}` : 'doc';
    console.log(`  ${type}${score}${project}  ${r.source_file || r.id}`);
    if (r.content) {
      const preview = truncate(r.content.replace(/\n/g, ' ').trim(), 120);
      console.log(`    ${preview}`);
    }
    console.log();
  }
}

export function printThreads(threads: any[], total: number): void {
  if (threads.length === 0) {
    console.log('No threads found.');
    return;
  }
  console.log(`${total} thread${total !== 1 ? 's' : ''}:\n`);
  for (const t of threads) {
    const status = t.status === 'open' ? '*' : ' ';
    const msgs = t.message_count ? ` (${t.message_count} msgs)` : '';
    console.log(`  [${status}] #${t.id} ${t.title}${msgs}`);
    if (t.created_at) console.log(`      ${t.created_at}`);
  }
}

export function printThread(thread: any, messages: any[]): void {
  console.log(`Thread #${thread.id}: ${thread.title}`);
  console.log(`Status: ${thread.status}  Created: ${thread.created_at}`);
  if (thread.issue_url) console.log(`Issue: ${thread.issue_url}`);
  console.log('---');
  for (const m of messages) {
    const role = m.role === 'oracle' ? 'Oracle' : m.author || m.role;
    console.log(`\n[${role}] ${m.created_at}`);
    console.log(m.content);
  }
}

export function printSchedule(events: any[], total: number): void {
  if (events.length === 0) {
    console.log('No scheduled events.');
    return;
  }
  console.log(`${total} event${total !== 1 ? 's' : ''}:\n`);
  for (const e of events) {
    const time = e.time ? ` @ ${e.time}` : '';
    const status = e.status === 'done' ? ' [done]' : '';
    console.log(`  ${e.date}${time}${status}  ${e.event}`);
    if (e.notes) console.log(`    ${e.notes}`);
  }
}

export function printTraces(traces: any[], total: number): void {
  if (traces.length === 0) {
    console.log('No traces found.');
    return;
  }
  console.log(`${total} trace${total !== 1 ? 's' : ''}:\n`);
  for (const t of traces) {
    const project = t.project ? ` [${t.project}]` : '';
    const status = t.status ? ` (${t.status})` : '';
    console.log(`  ${t.id} ${t.title || t.name || '(untitled)'}${status}${project}`);
    if (t.description) console.log(`    ${truncate(t.description, 100)}`);
  }
}

export function printInbox(files: any[], total: number): void {
  if (files.length === 0) {
    console.log('Inbox is empty.');
    return;
  }
  console.log(`${total} item${total !== 1 ? 's' : ''} in inbox:\n`);
  for (const f of files) {
    console.log(`  [${f.type}] ${f.filename}`);
    console.log(`    ${f.created}`);
    if (f.preview) console.log(`    ${truncate(f.preview.replace(/\n/g, ' '), 100)}`);
    console.log();
  }
}
