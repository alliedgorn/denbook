import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AI_MODULES } from './aiModules';
import { RichText } from './RichText';
import { useStudyProgress, type SyncState } from './useStudyProgress';
import type { StudyModule } from './types';
import styles from '../pages/Study.module.css';

// AI engineering interview block (T#963) — Learn / Quiz / Drill per topic.
// Progress shape is unchanged from the original app so it stays importable.

type DrillRating = 'solid' | 'shaky' | 'blank';

export interface AiProgress {
  read: Record<string, true>;
  quiz: Record<string, Record<number, number>>;
  best: Record<string, number>;
  drill: Record<string, DrillRating>;
  notes: Record<string, string>;
  updatedAt: number;
}

export const AI_EMPTY = (): AiProgress => ({ read: {}, quiz: {}, best: {}, drill: {}, notes: {}, updatedAt: 0 });
const TABS = ['learn', 'quiz', 'drill'] as const;
type Tab = (typeof TABS)[number];

function modStats(m: StudyModule, s: AiProgress) {
  const read = m.concepts.filter((_, i) => s.read[`${m.id}:${i}`]).length;
  const best = s.best[m.id] || 0;
  let dsum = 0;
  let rated = 0;
  m.drills.forEach((_, i) => {
    const r = s.drill[`${m.id}:${i}`];
    if (r) rated++;
    dsum += r === 'solid' ? 1 : r === 'shaky' ? 0.5 : 0;
  });
  const pct = Math.round(100 * (0.3 * read / m.concepts.length + 0.35 * best + 0.35 * dsum / m.drills.length));
  return { read, best, rated, pct };
}

function status(pct: number): [string, string] {
  if (pct >= 80) return [styles.pillGood, 'Interview-ready'];
  if (pct >= 45) return [styles.pillWarn, 'Getting there'];
  if (pct > 0) return [styles.pillLow, 'Needs reps'];
  return [styles.pillNone, 'Not started'];
}

export function Plates({ pct, small }: { pct: number; small?: boolean }) {
  const on = Math.round(pct / 10);
  return (
    <span className={small ? `${styles.plates} ${styles.platesSm}` : styles.plates} aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < on ? styles.plateOn : undefined} />)}
    </span>
  );
}

export function SyncBadge({ sync, onRetry }: { sync: SyncState; onRetry: () => void }) {
  const text: Record<SyncState, string> = {
    loading: 'Loading your progress…',
    saving: 'Saving…',
    saved: 'Saved',
    error: "Couldn't save. Check your connection.",
    'load-error': "Couldn't load your progress.",
  };
  return (
    <span className={styles.sync} data-s={sync}>
      {text[sync]}
      {sync === 'load-error' && <button className={styles.linkBtn} onClick={onRetry}>Retry</button>}
    </span>
  );
}

export function aiTrackPct(s: AiProgress) {
  const all = AI_MODULES.map(m => modStats(m, s).pct);
  return Math.round(all.reduce((a, b) => a + b, 0) / all.length);
}

export function AiTrack() {
  const { state, update, sync, reload } = useStudyProgress<AiProgress>('ai', AI_EMPTY);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const modId = params.get('m');
  const mod = AI_MODULES.find(m => m.id === modId) || null;
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'learn';
  const ready = sync !== 'loading' && sync !== 'load-error';

  const go = (id: string | null, t: Tab = 'learn') => {
    const p = new URLSearchParams();
    if (id) { p.set('m', id); if (t !== 'learn') p.set('tab', t); }
    setParams(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const touch = (fn: (s: AiProgress) => void) => update(prev => {
    const next: AiProgress = JSON.parse(JSON.stringify(prev));
    fn(next);
    next.updatedAt = Date.now();
    return next;
  });
  const total = aiTrackPct(state);

  return (
    <div className={styles.container}>
      <div className={styles.crumbs}><Link to="/study">Study</Link> / AI engineering</div>
      <div className={styles.trackHead}>
        <div>
          <h1>AI engineering interview block</h1>
          <SyncBadge sync={sync} onRetry={reload} />
        </div>
        <div className={styles.total}><Plates pct={total} /><b>{total}%</b></div>
      </div>

      <div className={styles.layout}>
        <nav className={styles.rail} aria-label="Topics">
          <button className={styles.modBtn} aria-current={!mod} onClick={() => go(null)}>
            <span className={styles.num}>00</span><span className={styles.nm}>Overview</span>
            <span className={styles.sub}>{AI_MODULES.length} topics</span>
          </button>
          {AI_MODULES.map((m, i) => {
            const s = modStats(m, state);
            return (
              <button key={m.id} className={styles.modBtn} aria-current={mod?.id === m.id} onClick={() => go(m.id)}>
                <span className={styles.num}>{String(i + 1).padStart(2, '0')}</span>
                <span className={styles.nm}>{m.name}</span>
                <span className={styles.sub}><Plates pct={s.pct} small />{s.pct}%</span>
              </button>
            );
          })}
        </nav>

        <main className={styles.panel}>
          {!ready && sync === 'loading' && <p className={styles.muted}>Loading…</p>}
          {sync === 'load-error' && (
            <p className={styles.muted}>Your saved progress didn't load, so editing is paused to keep it safe. Hit Retry above.</p>
          )}
          {ready && !mod && <Overview state={state} go={go} onReset={() => update(() => ({ ...AI_EMPTY(), updatedAt: Date.now() }))} />}
          {ready && mod && (
            <ModuleView
              m={mod} tab={tab} state={state} open={open}
              setOpen={(k, v) => setOpen(o => ({ ...o, [k]: v }))}
              go={go} touch={touch}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function Overview({ state, go, onReset }: { state: AiProgress; go: (id: string | null) => void; onReset: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const weakest = AI_MODULES.map(m => ({ m, s: modStats(m, state) })).sort((a, b) => a.s.pct - b.s.pct)[0];
  return (
    <>
      <p className={styles.eyebrow}>Overview</p>
      <h2>Load the bar one topic at a time</h2>
      <p className={styles.lede}>Each topic has three parts. Read the lessons, pass the quiz, then answer the interview drills out loud and rate yourself honestly. Your progress saves as you go.</p>
      <div className={styles.next}>
        <div>
          <p className={styles.eyebrow}>Next up</p>
          <h3>{weakest.m.name}</h3>
          <p>Your weakest topic right now, at {weakest.s.pct}%.</p>
        </div>
        <button className={`${styles.btn} ${styles.primary}`} onClick={() => go(weakest.m.id)}>Start session →</button>
      </div>
      <div className={styles.tbl}>
        <table className={styles.log}>
          <thead><tr><th>Topic</th><th>Lessons</th><th>Quiz best</th><th>Drills</th><th>Status</th></tr></thead>
          <tbody>
            {AI_MODULES.map(m => {
              const s = modStats(m, state);
              const [cls, lab] = status(s.pct);
              return (
                <tr key={m.id}>
                  <td><button className={styles.linkBtn} onClick={() => go(m.id)}>{m.name}</button></td>
                  <td>{s.read}/{m.concepts.length}</td>
                  <td>{state.best[m.id] != null ? `${Math.round(s.best * 100)}%` : '–'}</td>
                  <td>{s.rated}/{m.drills.length}</td>
                  <td><span className={`${styles.pill} ${cls}`}>{lab}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.how}>
        <div><b>Learn</b>Short lessons, each ending with one line you can say in the interview.</div>
        <div><b>Quiz</b>Scenario questions with explanations. Your best score counts.</div>
        <div><b>Drill</b>Real interview questions. Answer out loud, jot the bones, compare with the model answer.</div>
      </div>
      <div className={styles.danger}>
        {!confirm ? (
          <><span>Want a clean start? </span><button className={styles.btn} onClick={() => setConfirm(true)}>Reset all progress</button></>
        ) : (
          <>
            <span>This clears lessons, quiz scores, drill ratings and notes for every topic. </span>
            <button className={styles.btn} onClick={() => { onReset(); setConfirm(false); }}>Yes, clear everything</button>
            <button className={styles.btn} onClick={() => setConfirm(false)}>Keep my progress</button>
          </>
        )}
      </div>
    </>
  );
}

interface ModuleViewProps {
  m: StudyModule;
  tab: Tab;
  state: AiProgress;
  open: Record<string, boolean>;
  setOpen: (k: string, v: boolean) => void;
  go: (id: string | null, t?: Tab) => void;
  touch: (fn: (s: AiProgress) => void) => void;
}

function ModuleView({ m, tab, state, open, setOpen, go, touch }: ModuleViewProps) {
  const idx = AI_MODULES.indexOf(m);
  const s = modStats(m, state);
  const counts: Record<Tab, string> = {
    learn: `${s.read}/${m.concepts.length}`,
    quiz: state.best[m.id] != null ? `best ${Math.round(s.best * 100)}%` : `${m.quiz.length} Qs`,
    drill: `${s.rated}/${m.drills.length}`,
  };
  const ti = TABS.indexOf(tab);
  const nextMod = AI_MODULES[idx + 1];
  return (
    <>
      <p className={styles.eyebrow}>Topic {idx + 1} of {AI_MODULES.length} · {s.pct}% ready</p>
      <h2>{m.name}</h2>
      <p className={styles.lede}>{m.lede}</p>
      <div className={styles.tabs} role="tablist">
        {TABS.map(k => (
          <button key={k} className={styles.tab} role="tab" aria-selected={tab === k} onClick={() => go(m.id, k)}>
            {k === 'learn' ? 'Learn' : k === 'quiz' ? 'Quiz' : 'Drill'}<span className={styles.ct}>{counts[k]}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'learn' && <Learn m={m} state={state} touch={touch} />}
        {tab === 'quiz' && <Quiz m={m} state={state} touch={touch} />}
        {tab === 'drill' && <Drills m={m} state={state} touch={touch} open={open} setOpen={setOpen} />}
      </div>
      <div className={styles.footNav}>
        {ti < 2 && <button className={styles.btn} onClick={() => go(m.id, TABS[ti + 1])}>{ti === 0 ? 'Next: Quiz →' : 'Next: Drill →'}</button>}
        {ti === 2 && nextMod && <button className={styles.btn} onClick={() => go(nextMod.id)}>Next topic: {nextMod.name} →</button>}
        {ti === 2 && !nextMod && <button className={styles.btn} onClick={() => go(null)}>Back to overview</button>}
      </div>
    </>
  );
}

export type PartProps = { m: StudyModule; state: AiProgress; touch: (fn: (s: AiProgress) => void) => void };

export function Learn({ m, state, touch }: PartProps) {
  return (
    <div className={styles.cards}>
      {m.concepts.map((c, i) => {
        const key = `${m.id}:${i}`;
        const done = !!state.read[key];
        return (
          <article key={key} className={done ? `${styles.card} ${styles.done}` : styles.card}>
            <h3>{c.t}</h3>
            <div className={styles.body}><RichText blocks={c.b} /></div>
            <div className={styles.say}><b>Say it in the interview</b>{c.say}</div>
            <div className={styles.row}>
              <button
                className={done ? `${styles.btn} ${styles.ok}` : styles.btn}
                aria-pressed={done}
                onClick={() => touch(s => { if (s.read[key]) delete s.read[key]; else s.read[key] = true; })}
              >{done ? '✓ Got it' : 'Mark as understood'}</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function Quiz({ m, state, touch }: PartProps) {
  const ans = state.quiz[m.id] || {};
  const answered = Object.keys(ans).length;
  const correct = m.quiz.filter((q, i) => ans[i] === q.a).length;
  const best = state.best[m.id];
  const answer = (qi: number, oi: number) => touch(s => {
    const a = (s.quiz[m.id] = { ...(s.quiz[m.id] || {}) });
    if (a[qi] != null) return;
    a[qi] = oi;
    if (Object.keys(a).length === m.quiz.length) {
      const sc = m.quiz.filter((q, i) => a[i] === q.a).length / m.quiz.length;
      s.best[m.id] = Math.max(s.best[m.id] || 0, sc);
    }
  });
  return (
    <>
      <div className={styles.score}>
        {answered === m.quiz.length
          ? <div>Score <b>{correct}/{m.quiz.length}</b> · best {Math.round((best || 0) * 100)}%</div>
          : <div>{answered}/{m.quiz.length} answered{best != null && <> · best so far <b>{Math.round(best * 100)}%</b></>}</div>}
        {answered > 0 && <button className={styles.btn} onClick={() => touch(s => { delete s.quiz[m.id]; })}>Retake quiz</button>}
      </div>
      {m.quiz.map((q, qi) => {
        const pick = ans[qi];
        return (
          <div key={qi} className={styles.q}>
            <span className={styles.qn}>Question {qi + 1}</span>
            <div className={styles.stem}>{q.q}</div>
            <div className={styles.opts}>
              {q.o.map((o, oi) => {
                let cls = styles.opt;
                if (pick != null) { if (oi === q.a) cls += ` ${styles.right}`; else if (oi === pick) cls += ` ${styles.wrong}`; }
                return (
                  <button key={oi} className={cls} disabled={pick != null} onClick={() => answer(qi, oi)}>
                    <span className={styles.k}>{'ABCD'[oi]}</span><span>{o}</span>
                  </button>
                );
              })}
            </div>
            {pick != null && <div className={styles.why}><b>{pick === q.a ? 'Correct.' : 'Not quite.'}</b> {q.w}</div>}
          </div>
        );
      })}
    </>
  );
}

export function Drills({ m, state, touch, open, setOpen }: PartProps & { open: Record<string, boolean>; setOpen: (k: string, v: boolean) => void }) {
  return (
    <>
      {m.drills.map((d, i) => {
        const key = `${m.id}:${i}`;
        const isOpen = !!open[key];
        return (
          <div key={key} className={styles.d}>
            <span className={styles.qn}>Drill {i + 1}</span>
            <div className={styles.prompt}>{d.p}</div>
            <textarea
              maxLength={2000}
              placeholder="Say your answer out loud first, then jot the main points here."
              value={state.notes[key] || ''}
              onChange={e => { const v = e.target.value; touch(s => { if (v) s.notes[key] = v; else delete s.notes[key]; }); }}
            />
            <div className={styles.row}>
              <button className={isOpen ? styles.btn : `${styles.btn} ${styles.primary}`} aria-expanded={isOpen} onClick={() => setOpen(key, !isOpen)}>
                {isOpen ? 'Hide model answer' : 'Show model answer'}
              </button>
            </div>
            {isOpen && <div className={styles.model}><b>A strong answer covers:</b><RichText blocks={d.m} /></div>}
            <div className={styles.rate}>
              <span>How did you do?</span>
              {([['solid', 'Nailed it'], ['shaky', 'Shaky'], ['blank', 'Blanked']] as [DrillRating, string][]).map(([v, lab]) => (
                <button
                  key={v} className={styles.chip} data-v={v} aria-pressed={state.drill[key] === v}
                  onClick={() => touch(s => { if (s.drill[key] === v) delete s.drill[key]; else s.drill[key] = v; })}
                >{lab}</button>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
