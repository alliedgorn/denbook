import { useState } from 'react';
import { consult } from '../api/oracle';
import type { ConsultResult } from '../api/oracle';
import styles from './Consult.module.css';

export function Consult() {
  const [decision, setDecision] = useState('');
  const [context, setContext] = useState('');
  const [result, setResult] = useState<ConsultResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision.trim()) return;

    setLoading(true);
    try {
      const data = await consult(decision, context || undefined);
      setResult(data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Consult Oracle</h1>
      <p className={styles.subtitle}>
        Get guidance on decisions based on Oracle's philosophy and patterns
      </p>

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label}>What decision are you facing?</label>
          <input
            type="text"
            value={decision}
            onChange={e => setDecision(e.target.value)}
            placeholder="e.g., Should I force push to main?"
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Additional context (optional)</label>
          <textarea
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder="Describe the situation, constraints, or relevant details..."
            className={styles.textarea}
            rows={4}
          />
        </div>

        <button type="submit" disabled={loading || !decision.trim()} className={styles.button}>
          {loading ? 'Consulting...' : 'Get Guidance'}
        </button>
      </form>

      {result && (
        <div className={styles.result}>
          <div className={styles.guidance}>
            <h2 className={styles.guidanceTitle}>Guidance</h2>
            <p className={styles.guidanceText}>{result.guidance}</p>
          </div>

          {result.principles.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Relevant Principles</h3>
              {result.principles.map((p, i) => (
                <div key={i} className={styles.item}>
                  <p className={styles.itemContent}>{p.content}</p>
                  <p className={styles.itemSource}>{p.source_file}</p>
                </div>
              ))}
            </div>
          )}

          {result.patterns.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Matching Patterns</h3>
              {result.patterns.map((p, i) => (
                <div key={i} className={styles.item}>
                  <p className={styles.itemContent}>{p.content}</p>
                  <p className={styles.itemSource}>{p.source_file}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
