import { Link, Navigate, useParams } from 'react-router-dom';
import { AI_EMPTY, AiTrack, Plates, aiTrackPct } from '../study/AiTrack';
import { BootcampTrack } from '../study/BootcampTrack';
import { BOOT_EMPTY, bootTrackPct } from '../study/bootProgress';
import { useStudyProgress } from '../study/useStudyProgress';
import styles from './Study.module.css';

// Study area (T#963) — owner-only. The route sits behind RequireAuth and is not
// in GUEST_ROUTES; the API independently rejects anything but an owner session.

function StudyHome() {
  const ai = useStudyProgress('ai', AI_EMPTY);
  const boot = useStudyProgress('bootcamp', BOOT_EMPTY);
  const pct = ai.sync === 'loading' || ai.sync === 'load-error' ? null : aiTrackPct(ai.state);
  const bootPct = boot.sync === 'loading' || boot.sync === 'load-error' ? null : bootTrackPct(boot.state);
  return (
    <div className={styles.container}>
      <div className={styles.homeHead}>
        <h1>Study</h1>
        <p className={styles.lede}>Your learning tracks. Progress saves to the Den as you go.</p>
      </div>
      <div className={styles.trackGrid}>
        <Link to="/study/bootcamp" className={styles.trackCard}>
          <span className={styles.eyebrow}>Track</span>
          <h3>AI engineer bootcamp</h3>
          <p>Hands-on, local models first. Learn it, build it yourself, break it, then defend it in an interview drill. With a daily log.</p>
          <span className={styles.trackPct}>
            {bootPct == null ? '…' : <><Plates pct={bootPct} small /> {bootPct}%</>}
          </span>
        </Link>
        <Link to="/study/ai" className={styles.trackCard}>
          <span className={styles.eyebrow}>Track</span>
          <h3>AI engineering interview block</h3>
          <p>RAG, agents, evals, security, cost, observability and regulated industries. Learn, quiz, then drill out loud.</p>
          <span className={styles.trackPct}>
            {pct == null ? '…' : <><Plates pct={pct} small /> {pct}%</>}
          </span>
        </Link>
      </div>
    </div>
  );
}

export function Study() {
  const { track } = useParams();
  if (!track) return <StudyHome />;
  if (track === 'ai') return <AiTrack />;
  if (track === 'bootcamp') return <BootcampTrack />;
  return <Navigate to="/study" replace />;
}
