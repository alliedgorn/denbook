// Shared by the Ask Karo panel and the lab cards (LabCheck). Kept out of the
// component files so React fast refresh keeps working (eslint only-export-components).

export const PEER = 'karo';

export interface Msg {
  id: number;
  sender: string;
  message: string;
  created_at: string;
}

// Chat-style line breaks: a single newline starts a new line, like in the DMs.
// Markdown would join those lines, so turn them into hard breaks, but leave
// fenced code blocks alone.
export function chatBreaks(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('');
}

// Same-origin by resolved origin, not by a leading "/": "//host" and "/\host"
// also start with a slash and leave the site (Bertus, PR 140 review).
function isSameOrigin(href: string): boolean {
  try { return new URL(href, window.location.origin).origin === window.location.origin; } catch { return false; }
}

export const MD_COMPONENTS = {
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return href && isSameOrigin(href)
      ? <a href={href}>{children}</a>
      : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    return <img src={src} alt={alt || ''} loading="lazy" />;
  },
};

// The lab cards (LabCheck) read verdicts from this same thread. This panel stays
// the only poller: it publishes each loaded list, and a lab send asks it to reload.
export const THREAD_EVENT = 'study-karo-thread';
export const REFRESH_EVENT = 'study-karo-thread-refresh';
let lastThread: Msg[] = [];
export function latestThread(): Msg[] { return lastThread; }
export function publishThread(list: Msg[]) {
  lastThread = list;
  window.dispatchEvent(new CustomEvent(THREAD_EVENT, { detail: list }));
}
export function refreshThread() { window.dispatchEvent(new Event(REFRESH_EVENT)); }
