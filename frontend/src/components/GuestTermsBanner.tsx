import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from './GuestTermsBanner.module.css';

// Guest message terms (Gorn 11-17). A guest who hasn't accepted the current terms
// sees this under the header on every page. They can keep reading; sending a DM or
// a post, or uploading, is refused by the server until they press "I understand".
// The text and version come from the server, so the words shown are the words accepted.

interface Terms { version: number; text: string; accepted: boolean }

export function GuestTermsBanner() {
  const { isGuest, termsAccepted, checkAuth } = useAuth();
  const [terms, setTerms] = useState<Terms | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const show = isGuest && !termsAccepted;

  useEffect(() => {
    if (!show) return;
    fetch('/api/guest/terms', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && typeof j.text === 'string' && typeof j.version === 'number') setTerms(j); })
      .catch(() => { /* banner stays without text; the server still blocks sends */ });
  }, [show]);

  if (!show || !terms || terms.accepted) return null;

  const accept = async () => {
    setState('saving');
    try {
      const r = await fetch('/api/guest/terms/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: terms.version }),
      });
      if (!r.ok) throw new Error(String(r.status));
      await checkAuth();
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <div className={styles.banner} role="region" aria-label="Message terms">
      <p className={styles.text}>
        <b>Before you send anything: </b>{terms.text}
      </p>
      <div className={styles.row}>
        <button className={styles.btn} onClick={accept} disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'I understand'}
        </button>
        {state === 'error' && <span className={styles.err}>Didn't save. Reload the page and try again.</span>}
      </div>
    </div>
  );
}
