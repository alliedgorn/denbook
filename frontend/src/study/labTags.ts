// Tags for the lab check (Gorn 11-13). Their own module so AskKaro and LabCheck
// can both read them without importing each other.
// Gorn's lab answer: "[Study: …]\n[Lab <key>]\n<fenced code>".
export const LAB_TAG_RE = /^\[Lab ([a-z0-9-]{1,60}:\d{1,3})\][ \t]*\n?/;
// Karo's verdict: "[Lab <key> pass]" or "[Lab <key> fix]", then a short note.
export const VERDICT_RE = /^\[Lab ([a-z0-9-]{1,60}:\d{1,3}) (pass|fix)\][ \t]*\n?/;

// A fence longer than any backtick run inside the text, so pasted code
// can't close the block early.
export function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map(r => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}
