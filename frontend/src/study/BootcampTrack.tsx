import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BOOT_MODULES, BOOT_PLANNED } from './bootModules';
import { AskKaro } from './AskKaro';
import { LabCheck } from './LabCheck';
import { LabToolbox } from './LabToolbox';
import { RichText } from './RichText';
import { useStudyProgress } from './useStudyProgress';
import { Drills, Learn, Plates, Quiz, SyncBadge } from './AiTrack';
import { BOOT_EMPTY, bootTrackPct, modStats, type BootProgress, type LogEntry } from './bootProgress';
import type { BootModule } from './types';
import styles from '../pages/Study.module.css';

// AI engineer bootcamp (T#967) — schedule, daily log, then Learn / Lab / Quiz /
// Drill per module. Reuses the AI track's Learn/Quiz/Drill parts, so the
// progress shape is a superset of AiProgress.

const TABS = ['learn', 'lab', 'quiz', 'drill'] as const;
type Tab = (typeof TABS)[number];
const TAB_NAME: Record<Tab, string> = { learn: 'Learn', lab: 'Lab', quiz: 'Quiz', drill: 'Drill' };
const LOG_DAYS = 14;

// Local calendar date, so "today" matches the clock on his laptop.
function dayKey(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function BootcampTrack() {
  const { state, update, sync, reload } = useStudyProgress<BootProgress>('bootcamp', BOOT_EMPTY);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const modId = params.get('m');
  const mod = BOOT_MODULES.find(m => m.id === modId) || null;
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'learn';
  const ready = sync !== 'loading' && sync !== 'load-error';

  const go = (id: string | null, t: Tab = 'learn') => {
    const p = new URLSearchParams();
    if (id) { p.set('m', id); if (t !== 'learn') p.set('tab', t); }
    setParams(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const touch = (fn: (s: BootProgress) => void) => update(prev => {
    const next: BootProgress = { ...BOOT_EMPTY(), ...JSON.parse(JSON.stringify(prev)) };
    fn(next);
    next.updatedAt = Date.now();
    return next;
  });
  const total = bootTrackPct(state);

  return (
    <div className={styles.container}>
      <div className={styles.crumbs}><Link to="/study">Study</Link> / AI engineer bootcamp</div>
      <div className={styles.trackHead}>
        <div>
          <h1>AI engineer bootcamp</h1>
          <SyncBadge sync={sync} onRetry={reload} />
        </div>
        <div className={styles.total}><Plates pct={total} /><b>{total}%</b></div>
      </div>

      <div className={styles.layout}>
        <nav className={styles.rail} aria-label="Modules">
          <button className={styles.modBtn} aria-current={!mod} onClick={() => go(null)}>
            <span className={styles.num}>00</span><span className={styles.nm}>Plan and daily log</span>
            <span className={styles.sub}>{BOOT_MODULES.length + BOOT_PLANNED.length} modules</span>
          </button>
          {BOOT_MODULES.map((m, i) => {
            const s = modStats(m, state);
            return (
              <button key={m.id} className={styles.modBtn} aria-current={mod?.id === m.id} onClick={() => go(m.id)}>
                <span className={styles.num}>{String(i + 1).padStart(2, '0')}</span>
                <span className={styles.nm}>{m.name}</span>
                <span className={styles.sub}><Plates pct={s.pct} small />{s.pct}%</span>
              </button>
            );
          })}
          {BOOT_PLANNED.map((m, i) => (
            <div key={m.id} className={`${styles.modBtn} ${styles.planned}`}>
              <span className={styles.num}>{String(BOOT_MODULES.length + i + 1).padStart(2, '0')}</span>
              <span className={styles.nm}>{m.name}</span>
              <span className={styles.sub}>{m.week}</span>
            </div>
          ))}
        </nav>

        <main className={styles.panel}>
          {!ready && sync === 'loading' && <p className={styles.muted}>Loading…</p>}
          {sync === 'load-error' && (
            <p className={styles.muted}>Your saved progress didn't load, so editing is paused to keep it safe. Hit Retry above.</p>
          )}
          {ready && !mod && <Plan state={state} touch={touch} go={go} />}
          {ready && mod && (
            <ModuleView
              m={mod} tab={tab} state={state} open={open}
              setOpen={(k, v) => setOpen(o => ({ ...o, [k]: v }))}
              go={go} touch={touch}
            />
          )}
        </main>
      </div>
      <AskKaro context={mod ? `Bootcamp › ${mod.name} › ${TAB_NAME[tab]}` : 'Bootcamp › Plan'} />
    </div>
  );
}

type Touch = (fn: (s: BootProgress) => void) => void;

function Plan({ state, touch, go }: { state: BootProgress; touch: Touch; go: (id: string | null, t?: Tab) => void }) {
  const today = dayKey(new Date());
  const entry = state.log[today];
  const next = BOOT_MODULES.map(m => ({ m, s: modStats(m, state) })).find(x => x.s.labs < x.m.labs.length);
  const nextLab = next ? next.m.labs.findIndex((_, i) => !state.labs[`${next.m.id}:${i}`]) : -1;

  const days = Array.from({ length: LOG_DAYS }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (LOG_DAYS - 1 - i));
    return d;
  });
  const setToday = (patch: Partial<LogEntry>) => touch(s => {
    const cur = s.log[today] || { shipped: '', ran: false };
    const merged = { ...cur, ...patch };
    if (!merged.shipped && !merged.ran) delete s.log[today];
    else s.log[today] = merged;
  });

  return (
    <>
      <p className={styles.eyebrow}>Plan</p>
      <h2>Treat it like a job</h2>
      <p className={styles.lede}>Intense in depth, gentle in pace. Every module is first principles, then build it yourself, then break it, then an interview drill. Every session ends with code that runs.</p>

      {next && nextLab >= 0 && (
        <div className={styles.next}>
          <div>
            <p className={styles.eyebrow}>Next up · {next.m.labs[nextLab].day}</p>
            <h3>{next.m.labs[nextLab].t}</h3>
            <p>{next.m.labs[nextLab].goal}</p>
          </div>
          <button className={`${styles.btn} ${styles.primary}`} onClick={() => go(next.m.id, 'lab')}>Open the lab →</button>
        </div>
      )}

      <h3 className={styles.sectionH}>Today's log</h3>
      <div className={styles.d}>
        <span className={styles.qn}>{today}</span>
        <textarea
          maxLength={1000}
          placeholder="What did you ship today? One or two lines: what runs now that didn't this morning."
          value={entry?.shipped || ''}
          onChange={e => setToday({ shipped: e.target.value })}
        />
        <div className={styles.row}>
          <button
            className={entry?.ran ? `${styles.btn} ${styles.ok}` : styles.btn}
            aria-pressed={!!entry?.ran}
            onClick={() => setToday({ ran: !entry?.ran })}
          >{entry?.ran ? '✓ My code ran today' : 'Mark: my code ran today'}</button>
        </div>
      </div>
      <div className={styles.logStrip} aria-label={`Last ${LOG_DAYS} days`}>
        {days.map(d => {
          const k = dayKey(d);
          const e = state.log[k];
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          const v = e?.ran ? 'ran' : e ? 'logged' : weekend ? 'off' : 'empty';
          return <span key={k} className={styles.logDay} data-v={v} title={`${k}${e?.shipped ? `: ${e.shipped}` : ''}`}>{d.getDate()}</span>;
        })}
      </div>
      <p className={styles.muted}>Green: code ran. Amber: logged, nothing ran. Grey: weekend. An empty weekday is a skip, and Karo will ask about it.</p>

      <h3 className={styles.sectionH}>The working day</h3>
      <div className={styles.tbl}>
        <table className={styles.log}>
          <thead><tr><th>Time</th><th>Block</th><th>What</th></tr></thead>
          <tbody>
            <tr><td>09:30 – 12:30</td><td>Build</td><td>The module's lab. Hands on the keyboard.</td></tr>
            <tr><td>13:30 – 15:30</td><td>Learn + drill</td><td>Lessons, quiz, then interview drills out loud with Karo.</td></tr>
            <tr><td>15:30 – 17:00</td><td>Job hunt</td><td>Portfolio, CV, applications, reaching out to people.</td></tr>
          </tbody>
        </table>
      </div>
      <p className={styles.muted}>Ramp: week 1 is about 4 hours a day (build + learn), week 2 about 6, week 3 the full day. Evenings are for training.</p>

      <h3 className={styles.sectionH}>Rules</h3>
      <div className={styles.how}>
        <div><b>A real number</b>Show up on the plan, not on mood.</div>
        <div><b>Code that runs</b>Every session ends with something working, typed by you.</div>
        <div><b>AI as pair, not author</b>You can explain and change every line without it. Fundamentals you write yourself first.</div>
        <div><b>Honest ratings</b>Mid is mid. Skips get named, then we plan tomorrow.</div>
      </div>

      <h3 className={styles.sectionH}>Job hunt runs alongside</h3>
      <div className={styles.body}>
        <ul>
          <li><b>Week 1:</b> GitHub profile cleaned up; the bootcamp repo is public by Friday.</li>
          <li><b>Week 2:</b> CV and LinkedIn rewritten around the projects; a target list of 20 companies.</li>
          <li><b>Week 3 onward:</b> applications every week, in parallel. Don't wait to "finish the course".</li>
          <li>Aim wide: AI engineer, applied AI, and solutions or sales engineer at AI companies.</li>
        </ul>
      </div>

      <h3 className={styles.sectionH}>Modules</h3>
      <div className={styles.tbl}>
        <table className={styles.log}>
          <thead><tr><th>Module</th><th>When</th><th>Status</th></tr></thead>
          <tbody>
            {BOOT_MODULES.map(m => {
              const s = modStats(m, state);
              return (
                <tr key={m.id}>
                  <td><button className={styles.linkBtn} onClick={() => go(m.id)}>{m.name}</button></td>
                  <td>{m.week}</td>
                  <td>{s.labs}/{m.labs.length} labs · {s.pct}%</td>
                </tr>
              );
            })}
            {BOOT_PLANNED.map(m => (
              <tr key={m.id}><td>{m.name}<div className={styles.muted}>{m.lede}</div></td><td>{m.week}</td><td className={styles.muted}>Written before you get there</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface ModuleViewProps {
  m: BootModule;
  tab: Tab;
  state: BootProgress;
  open: Record<string, boolean>;
  setOpen: (k: string, v: boolean) => void;
  go: (id: string | null, t?: Tab) => void;
  touch: Touch;
}

function ModuleView({ m, tab, state, open, setOpen, go, touch }: ModuleViewProps) {
  const idx = BOOT_MODULES.indexOf(m);
  const s = modStats(m, state);
  const counts: Record<Tab, string> = {
    learn: `${s.read}/${m.concepts.length}`,
    lab: `${s.labs}/${m.labs.length}`,
    quiz: state.best[m.id] != null ? `best ${Math.round(s.best * 100)}%` : `${m.quiz.length} Qs`,
    drill: `${s.rated}/${m.drills.length}`,
  };
  const ti = TABS.indexOf(tab);
  return (
    <>
      <p className={styles.eyebrow}>Module {idx + 1} · {m.week} · {s.pct}%</p>
      <h2>{m.name}</h2>
      <p className={styles.lede}>{m.lede}</p>
      <div className={styles.tabs} role="tablist">
        {TABS.map(k => (
          <button key={k} className={styles.tab} role="tab" aria-selected={tab === k} onClick={() => go(m.id, k)}>
            {TAB_NAME[k]}<span className={styles.ct}>{counts[k]}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'learn' && <Learn m={m} state={state} touch={touch} />}
        {tab === 'lab' && <Labs m={m} state={state} touch={touch} />}
        {tab === 'quiz' && <Quiz m={m} state={state} touch={touch} />}
        {tab === 'drill' && <Drills m={m} state={state} touch={touch} open={open} setOpen={setOpen} />}
      </div>
      <div className={styles.footNav}>
        {ti < TABS.length - 1 && <button className={styles.btn} onClick={() => go(m.id, TABS[ti + 1])}>Next: {TAB_NAME[TABS[ti + 1]]} →</button>}
        {ti === TABS.length - 1 && <button className={styles.btn} onClick={() => go(null)}>Back to the plan</button>}
      </div>
    </>
  );
}

function Labs({ m, state, touch }: { m: BootModule; state: BootProgress; touch: Touch }) {
  return (
    <div className={styles.cards}>
      {m.labs.map((lab, i) => {
        const key = `${m.id}:${i}`;
        const done = !!state.labs[key];
        return (
          <article key={key} className={done ? `${styles.card} ${styles.done}` : styles.card}>
            <span className={styles.qn}>{lab.day}</span>
            <h3>{lab.t}</h3>
            <p className={styles.muted}>{lab.goal}</p>
            <div className={styles.body}><RichText blocks={lab.steps} /></div>
            <LabToolbox tools={lab.tools} docs={lab.docs} />
            <div className={styles.say}><b>Done when</b>{lab.done}</div>
            <LabCheck labKey={key} context={`Bootcamp › ${m.name} › Lab › ${lab.t}`} />
            <div className={styles.row}>
              <button
                className={done ? `${styles.btn} ${styles.ok}` : styles.btn}
                aria-pressed={done}
                onClick={() => touch(s => { if (s.labs[key]) delete s.labs[key]; else s.labs[key] = true; })}
              >{done ? '✓ Done, and it runs' : 'Mark done (only if it runs)'}</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
