import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from '../pages/Study.module.css';

// "Ask Karo" (T#968) — a study-side view of the existing gorn ↔ karo DM thread.
// Sending is a normal owner DM (POST /api/dm, sender derived server-side from the
// owner session); each message is prefixed with where Gorn is in the course so
// Karo has context. Messages render as markdown through react-markdown, the same
// as the DMs page: no rehype-raw, so raw HTML in a message stays text, and
// react-markdown's default urlTransform drops javascript: and other unsafe URLs.
// DM GETs are audited, so polling is deliberately slow (Bertus, T#968): the
// panel refetches right after a send instead of polling fast.

const PEER = 'karo';
const OPEN_POLL_MS = 10000;
const CLOSED_POLL_MS = 120000;
const SEEN_KEY = 'study-ask-karo-seen';
const CTX_RE = /^\[Study: ([^\]\n]{1,200})\]\n?/;

interface Msg {
  id: number;
  sender: string;
  message: string;
  created_at: string;
}

// Chat-style line breaks: a single newline starts a new line, like in the DMs.
// Markdown would join those lines, so turn them into hard breaks, but leave
// fenced code blocks alone.
function chatBreaks(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('');
}

// Same-origin by resolved origin, not by a leading "/": "//host" and "/\\host"
// also start with a slash and leave the site (Bertus, PR 140 review).
function isSameOrigin(href: string): boolean {
  try { return new URL(href, window.location.origin).origin === window.location.origin; } catch { return false; }
}

const MD_COMPONENTS = {
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return href && isSameOrigin(href)
      ? <a href={href}>{children}</a>
      : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    return <img src={src} alt={alt || ''} loading="lazy" />;
  },
};

function readSeen(): number {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
}
function writeSeen(id: number) {
  try { localStorage.setItem(SEEN_KEY, String(id)); } catch { /* private mode: badge just resets */ }
}

function time(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function AskKaro({ context }: { context: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'error' | 'load-error'>('idle');
  const [seen, setSeen] = useState(readSeen);
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dm/gorn/${PEER}?limit=40&order=desc`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const list: Msg[] = (body.messages || []).slice().reverse();
      setMsgs(list);
      setState(s => (s === 'load-error' ? 'idle' : s));
    } catch {
      setState(s => (s === 'sending' ? s : 'load-error'));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, open ? OPEN_POLL_MS : CLOSED_POLL_MS);
    return () => clearInterval(id);
  }, [open, load]);

  const lastKaro = msgs.filter(m => m.sender === PEER).reduce((a, m) => Math.max(a, m.id), 0);
  const unread = !open && lastKaro > seen;

  useEffect(() => {
    if (!open) return;
    if (lastKaro > seen) { setSeen(lastKaro); writeSeen(lastKaro); }
    endRef.current?.scrollIntoView({ block: 'end' });
    fetch(`/api/dm/gorn/${PEER}/read`, { method: 'PATCH' }).catch(() => { /* badge only */ });
  }, [open, lastKaro, seen, msgs.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch('/api/dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: PEER, message: `[Study: ${context}]\n${body}` }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setText('');
      setState('idle');
      load();
    } catch {
      setState('error');
    }
  };

  return (
    <>
      {!open && (
        <button className={styles.askFab} onClick={() => setOpen(true)} aria-label="Ask Karo">
          🦴 Ask Karo{unread && <span className={styles.askDot} aria-label="new reply" />}
        </button>
      )}
      {open && (
        <aside className={styles.askPanel} aria-label="Ask Karo">
          <div className={styles.askHead}>
            <b>Ask Karo</b>
            <button className={styles.linkBtn} onClick={() => setOpen(false)}>Close</button>
          </div>
          <div className={styles.askList}>
            {state === 'load-error' && <p className={styles.muted}>Couldn't load messages. Retrying…</p>}
            {msgs.length === 0 && state !== 'load-error' && (
              <p className={styles.muted}>Stuck, curious, or want me to check your code? Ask here. I'll see where you are in the course.</p>
            )}
            {msgs.map(m => {
              const mine = m.sender !== PEER;
              const ctx = mine ? CTX_RE.exec(m.message) : null;
              const bodyText = ctx ? m.message.slice(ctx[0].length) : m.message;
              return (
                <div key={m.id} className={mine ? `${styles.askMsg} ${styles.askMine}` : styles.askMsg}>
                  {ctx && <span className={styles.askCtx}>{ctx[1]}</span>}
                  <div className={styles.askText}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{chatBreaks(bodyText)}</ReactMarkdown>
                  </div>
                  <span className={styles.askTime}>{mine ? 'You' : 'Karo'} · {time(m.created_at)}</span>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          <div className={styles.askCompose}>
            <span className={styles.askCtx}>About: {context}</span>
            <textarea
              maxLength={2000}
              placeholder="Ask anything about this part…"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
            />
            <div className={styles.row}>
              <button className={`${styles.btn} ${styles.primary}`} disabled={!text.trim() || state === 'sending'} onClick={send}>
                {state === 'sending' ? 'Sending…' : 'Send'}
              </button>
              <span className={styles.muted}>{state === 'error' ? "Didn't send. Try again." : '⌘/Ctrl + Enter'}</span>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
