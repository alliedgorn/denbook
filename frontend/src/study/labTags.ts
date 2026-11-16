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

// Drill rounds (Gorn 11-16: "make drill page accept answers like lab page", "multiple rounds
// of answers so I can see how my understanding develops"). Own tag, because a drill key and
// a lab key share the "<module>:<n>" shape and a lab verdict must never land on a drill card.
// Gorn's answer: "[Study: …]\n[Drill <key>]\n<text>". Karo's grade: "[Drill <key> pass|fix]".
export const DRILL_TAG_RE = /^\[Drill ([a-z0-9-]{1,60}:\d{1,3})\][ \t]*\n?/;
export const DRILL_VERDICT_RE = /^\[Drill ([a-z0-9-]{1,60}:\d{1,3}) (pass|fix)\][ \t]*\n?/;
// Gorn 11-16: "put my answers in drill 1". An answer he sent through the plain chat before the box
// existed, carried onto the card by Karo: "[Drill <key> carry]\n<his text, quoted>". Only Karo can
// carry (Karo can't send as Gorn), and the card marks it as carried.
export const DRILL_CARRY_RE = /^\[Drill ([a-z0-9-]{1,60}:\d{1,3}) carry\][ \t]*\n?/;
