import { useState } from 'react';
import { consult } from '../api/oracle';
import type { ConsultResult } from '../api/oracle';
import styles from './Consult.module.css';

interface PopupContent {
  title: string;
  content: string;
  source: string;
}

export function Consult() {
  const [decision, setDecision] = useState('');
  const [context, setContext] = useState('');
  const [result, setResult] = useState<ConsultResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [popup, setPopup] = useState<PopupContent | null>(null);

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
          <div
            className={styles.guidance}
            onClick={() => setPopup({
              title: 'Guidance',
              content: result.guidance,
              source: 'Oracle Synthesis'
            })}
          >
            <h2 className={styles.guidanceTitle}>Guidance</h2>
            <p className={styles.guidanceText}>{result.guidance}</p>
          </div>

          {result.principles.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Relevant Principles</h3>
              {result.principles.map((p, i) => (
                <div
                  key={i}
                  className={styles.item}
                  onClick={() => setPopup({
                    title: 'Principle',
                    content: p.content,
                    source: p.source_file
                  })}
                >
                  <p className={styles.itemContent}>{p.content}</p>
                  <div className={styles.itemMeta}>
                    <span className={styles.itemSource}>{p.source_file}</span>
                    {p.source && <span className={`${styles.badge} ${styles[p.source]}`}>{p.source}</span>}
                    {p.score !== undefined && <span className={styles.score}>{(p.score * 100).toFixed(0)}%</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.patterns.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Matching Patterns</h3>
              {result.patterns.map((p, i) => (
                <div
                  key={i}
                  className={styles.item}
                  onClick={() => setPopup({
                    title: 'Pattern',
                    content: p.content,
                    source: p.source_file
                  })}
                >
                  <p className={styles.itemContent}>{p.content}</p>
                  <div className={styles.itemMeta}>
                    <span className={styles.itemSource}>{p.source_file}</span>
                    {p.source && <span className={`${styles.badge} ${styles[p.source]}`}>{p.source}</span>}
                    {p.score !== undefined && <span className={styles.score}>{(p.score * 100).toFixed(0)}%</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {popup && (
        <div className={styles.overlay} onClick={() => setPopup(null)}>
          <div className={styles.popup} onClick={e => e.stopPropagation()}>
            <div className={styles.popupHeader}>
              <h3 className={styles.popupTitle}>{popup.title}</h3>
              <button className={styles.popupClose} onClick={() => setPopup(null)}>×</button>
            </div>
            <div className={styles.popupContent}>
              {popup.content.split('\n').map((line, i) => (
                <p key={i} className={styles.popupLine}>{line || '\u00A0'}</p>
              ))}
            </div>
            <div className={styles.popupFooter}>
              <span className={styles.popupSource}>{popup.source}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
