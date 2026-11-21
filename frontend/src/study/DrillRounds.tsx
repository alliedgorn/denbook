import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from '../pages/Study.module.css';
import { MD_COMPONENTS, chatBreaks, latestThread, refreshThread, THREAD_EVENT } from './studyChat';
import { type Msg, type StudyChannel } from './studyPeer';
import { useStudyChannel } from './studyChannel';
import { drillEntries, gradeRating, latestRating, mergeEntries, pruneDeleted, RATING_ICON, RATING_LABEL, toRounds, type DrillRating, type Entry } from './drillParse';

// Drill rounds (Gorn 11-16). Each drill card keeps every answer Gorn sends and every grade
// Karo gives, in order, so he can watch an answer get sharper round by round. Same wiring as
// the lab check: answers go out as normal owner DMs to Karo, tagged with the drill key, and
// grades come back as DMs starting "[Drill <key> pass]" or "[Drill <key> fix]". Frontend
// only: no new route, no new table. The Ask Karo panel fetches only the newest 40 messages,
// so rounds are cached here by message id and merged, never replaced, or old rounds would
// drop off the card.

const ROUNDS_KEY = 'study-drill-rounds';
const DRAFTS_KEY = 'study-drill-drafts';
function readMap<T>(key: string): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeMap<T>(key: string, map: Record<string, T>) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* private mode: lasts while loaded */ }
}

function when(at: string): string {
  const d = new Date(at);
  return isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type Props = { drillKey: string; context: string; onRating?: (r: DrillRating) => void };

export function DrillRounds(p: Props) {
  const ch = useStudyChannel();
  return ch ? <DrillRoundsFor key={ch.storePrefix} ch={ch} {...p} /> : null;
}

function DrillRoundsFor({ ch, drillKey, context, onRating }: Props & { ch: StudyChannel }) {
  const ROUNDS = ch.storePrefix + ROUNDS_KEY, DRAFTS = ch.storePrefix + DRAFTS_KEY;
  const [entries, setEntries] = useState<Entry[]>(() => readMap<Entry[]>(ROUNDS)[drillKey] || []);
  const [draft, setDraft] = useState(() => readMap<string>(DRAFTS)[drillKey] || '');
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');

  useEffect(() => {
    const apply = (msgs: Msg[]) => {
      if (!msgs.length) return;
      const found = drillEntries(msgs, drillKey, ch.peer);
      setEntries(cur => {
        const merged = mergeEntries(pruneDeleted(cur, msgs), found);
        if (merged.length === cur.length && merged.every((e, i) => e.id === cur[i].id && e.text === cur[i].text)) return cur;
        const all = readMap<Entry[]>(ROUNDS);
        all[drillKey] = merged;
        writeMap(ROUNDS, all);
        return merged;
      });
    };
    apply(latestThread());
    const onThread = (e: Event) => apply((e as CustomEvent<Msg[]>).detail || []);
    window.addEventListener(THREAD_EVENT, onThread);
    return () => window.removeEventListener(THREAD_EVENT, onThread);
  }, [drillKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDraft = (v: string) => {
    setDraft(v);
    const all = readMap<string>(DRAFTS);
    if (v) all[drillKey] = v; else delete all[drillKey];
    writeMap(DRAFTS, all);
  };

  // The mentor's newest grade goes into progress (Gorn 11-17). Only ever set, never cleared on
  // absence: a fresh device has no cached rounds and the fetch window may not reach old grades,
  // so "no grade seen here" does not mean "no grade".
  const rating = latestRating(entries);
  useEffect(() => { if (rating) onRating?.(rating); }, [rating]); // eslint-disable-line react-hooks/exhaustive-deps

  const rounds = toRounds(entries);
  const last = rounds[rounds.length - 1];
  const waiting = !!last && last.grades.length === 0;

  const send = async () => {
    const body = draft.trim();
    if (!body || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch(ch.sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: ch.peer, message: `[Study: ${context}]\n[Drill ${drillKey}]\n${body}` }),
      });
      if (!res.ok) throw new Error(String(res.status));
      saveDraft('');
      setState('idle');
      refreshThread();
    } catch {
      setState('error');
    }
  };

  return (
    <div className={styles.labCheck}>
      <b className={styles.labCheckHead}>Answer to {ch.name}{rounds.length ? ` · ${rounds.length} round${rounds.length > 1 ? 's' : ''}` : ''}</b>
      {rounds.map((r, i) => (
        <div key={r.answer.id} className={styles.round}>
          <span className={styles.askCtx}>Round {i + 1} · {when(r.answer.at)}</span>
          <div className={styles.askText}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{chatBreaks(r.answer.text)}</ReactMarkdown>
          </div>
          {r.grades.map(g => {
            const gr = gradeRating(g) ?? 'shaky';
            const cls = gr === 'solid' ? styles.verdictOk : gr === 'shaky' ? styles.verdictShaky : styles.verdictFix;
            return (
            <div key={g.id} className={`${styles.verdict} ${cls}`}>
              <b>{RATING_ICON[gr]} {RATING_LABEL[gr]}</b>
              {g.text && (
                <div className={styles.askText}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{chatBreaks(g.text)}</ReactMarkdown>
                </div>
              )}
            </div>
            );
          })}
        </div>
      ))}
      {waiting && <p className={styles.muted}>Sent. {ch.name}'s grade will show under this round.</p>}
      <textarea
        maxLength={4000}
        placeholder={rounds.length ? `Round ${rounds.length + 1}: your sharper answer.` : 'Write your answer the way you would say it in the interview.'}
        value={draft}
        onChange={e => saveDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      <div className={styles.row}>
        <button className={`${styles.btn} ${styles.primary}`} disabled={!draft.trim() || state === 'sending'} onClick={send}>
          {state === 'sending' ? 'Sending…' : rounds.length ? `Send round ${rounds.length + 1}` : `Send to ${ch.name}`}
        </button>
        <span className={styles.muted}>{state === 'error' ? "Didn't send. Try again." : '⌘/Ctrl + Enter'}</span>
      </div>
    </div>
  );
}
