import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from '../pages/Study.module.css';
import { MD_COMPONENTS, PEER, chatBreaks, latestThread, refreshThread, THREAD_EVENT, type Msg } from './studyChat';
import { VERDICT_RE, fence } from './labTags';

// Lab check (Gorn 11-13: "put answer for you to check in the lab itself").
// Gorn pastes his code and output on the lab card; it goes out as a normal owner DM
// to Karo, tagged with the lab key. Karo answers with a DM that starts with
// "[Lab <key> pass]" or "[Lab <key> fix]", and that verdict shows on the card.
// Frontend only, like the pinned note: no new route, no new table. The thread data
// comes from the Ask Karo panel's own fetch (THREAD_EVENT), so this adds no extra
// audited DM polling. Marking a lab done stays Gorn's click.


const VERDICTS_KEY = 'study-lab-verdicts';
const SENT_KEY = 'study-lab-sent';
const DRAFTS_KEY = 'study-lab-drafts';

interface Verdict { id: number; ok: boolean; text: string; at: string }

function readMap<T>(key: string): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeMap<T>(key: string, map: Record<string, T>) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* private mode: lasts while loaded */ }
}

function newestVerdict(msgs: Msg[], key: string): Verdict | null {
  let best: Verdict | null = null;
  for (const m of msgs) {
    if (m.sender !== PEER) continue;
    const v = VERDICT_RE.exec(m.message);
    if (!v || v[1] !== key) continue;
    if (!best || m.id > best.id) {
      best = { id: m.id, ok: v[2] === 'pass', text: m.message.slice(v[0].length).trim(), at: m.created_at };
    }
  }
  return best;
}

export function LabCheck({ labKey, context }: { labKey: string; context: string }) {
  const [draft, setDraft] = useState(() => readMap<string>(DRAFTS_KEY)[labKey] || '');
  const [sentId, setSentId] = useState<number>(() => readMap<number>(SENT_KEY)[labKey] || 0);
  const [verdict, setVerdict] = useState<Verdict | null>(() => readMap<Verdict>(VERDICTS_KEY)[labKey] || null);
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');

  useEffect(() => {
    const apply = (msgs: Msg[]) => {
      const v = newestVerdict(msgs, labKey);
      if (!v) return;
      setVerdict(cur => {
        if (cur && cur.id >= v.id) return cur;
        const all = readMap<Verdict>(VERDICTS_KEY);
        all[labKey] = v;
        writeMap(VERDICTS_KEY, all);
        return v;
      });
    };
    apply(latestThread());
    const onThread = (e: Event) => apply((e as CustomEvent<Msg[]>).detail || []);
    window.addEventListener(THREAD_EVENT, onThread);
    return () => window.removeEventListener(THREAD_EVENT, onThread);
  }, [labKey]);

  const saveDraft = (v: string) => {
    setDraft(v);
    const all = readMap<string>(DRAFTS_KEY);
    if (v) all[labKey] = v; else delete all[labKey];
    writeMap(DRAFTS_KEY, all);
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch('/api/dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: PEER, message: `[Study: ${context}]\n[Lab ${labKey}]\n${fence(body)}` }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const out = await res.json().catch(() => ({}));
      const id = Number(out.message_id) || Date.now();
      setSentId(id);
      const all = readMap<number>(SENT_KEY);
      all[labKey] = id;
      writeMap(SENT_KEY, all);
      saveDraft('');
      setState('idle');
      refreshThread();
    } catch {
      setState('error');
    }
  };

  const pending = sentId > 0 && (!verdict || verdict.id < sentId);

  return (
    <div className={styles.labCheck}>
      <b className={styles.labCheckHead}>Check with Karo</b>
      {verdict && (
        <div className={verdict.ok ? `${styles.verdict} ${styles.verdictOk}` : `${styles.verdict} ${styles.verdictFix}`}>
          <b>{verdict.ok ? '✅ Pass' : '❌ Fix this'}{pending ? ' · last check' : ''}</b>
          {verdict.text && (
            <div className={styles.askText}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{chatBreaks(verdict.text)}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
      {pending && <p className={styles.muted}>Sent. Karo's check will show here.</p>}
      <p className={styles.muted}>Don't paste API keys, tokens or passwords. Everything you send here is kept.</p>
      <textarea
        maxLength={8000}
        placeholder="Paste your code, then what it printed when you ran it."
        value={draft}
        onChange={e => saveDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      <div className={styles.row}>
        <button className={`${styles.btn} ${styles.primary}`} disabled={!draft.trim() || state === 'sending'} onClick={send}>
          {state === 'sending' ? 'Sending…' : 'Send to Karo'}
        </button>
        <span className={styles.muted}>{state === 'error' ? "Didn't send. Try again." : '⌘/Ctrl + Enter'}</span>
      </div>
    </div>
  );
}
