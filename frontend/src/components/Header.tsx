import { Link, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import styles from './Header.module.css';

// Grouped with separators (no labels)
const navItems = [
  { path: '/', label: 'Overview' },
  { path: '/feed', label: 'Feed' },
  { path: '/search', label: 'Search' },
  { path: '/graph', label: 'Graph' },
  { divider: true },
  { path: '/forum', label: 'Forum' },
  { path: '/consult', label: 'Consult' },
  { divider: true },
  { path: '/decisions', label: 'Decisions' },
  { path: '/activity', label: 'Activity' },
  { divider: true },
  { path: '/handoff', label: 'Handoff' },
] as const;

interface SessionStats {
  searches: number;
  consultations: number;
  learnings: number;
  startTime: number;
}

export function Header() {
  const location = useLocation();
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [sessionStartTime] = useState(() => {
    // Get or initialize session start time from localStorage
    const stored = localStorage.getItem('oracle_session_start');
    if (stored) return parseInt(stored);
    const now = Date.now();
    localStorage.setItem('oracle_session_start', String(now));
    return now;
  });

  useEffect(() => {
    loadSessionStats();
    // Refresh stats every 30 seconds from backend
    const interval = setInterval(loadSessionStats, 30000);
    return () => clearInterval(interval);
  }, [sessionStartTime]);

  async function loadSessionStats() {
    try {
      // Fetch real stats from backend (includes MCP usage)
      const response = await fetch(`/api/session/stats?since=${sessionStartTime}`);
      if (response.ok) {
        const data = await response.json();
        setSessionStats({
          searches: data.searches,
          consultations: data.consultations,
          learnings: data.learnings,
          startTime: sessionStartTime
        });
      }
    } catch (e) {
      console.error('Failed to load session stats:', e);
      // Fallback to zeros on error
      setSessionStats({
        searches: 0,
        consultations: 0,
        learnings: 0,
        startTime: sessionStartTime
      });
    }
  }

  function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }

  const duration = sessionStats
    ? formatDuration(Date.now() - sessionStats.startTime)
    : '0m';

  return (
    <header className={styles.header}>
      <Link to="/" className={styles.logo}>
        Oracle
      </Link>

      <nav className={styles.nav}>
        {navItems.map((item, i) =>
          'divider' in item ? (
            <span key={i} className={styles.divider} />
          ) : (
            <Link
              key={item.path}
              to={item.path}
              className={`${styles.navLink} ${location.pathname === item.path ? styles.active : ''}`}
            >
              {item.label}
            </Link>
          )
        )}
      </nav>

      <div className={styles.sessionStats}>
        <span className={styles.statItem}>
          Session: {duration}
        </span>
        <span className={styles.statItem}>
          {sessionStats?.searches || 0} searches
        </span>
        <span className={styles.statItem}>
          {sessionStats?.learnings || 0} learnings
        </span>
      </div>
    </header>
  );
}
