import type { DocLink, LabTool } from './types';
import styles from '../pages/Study.module.css';

// "What you'll need" for a lab (Gorn 11-14). Closed by default, so trying first stays
// the habit and the card stays short; one click opens it. Everything is static text
// rendered as React elements. Links are fixed https URLs from the source.

const safeUrl = (u: string) => /^https:\/\//.test(u);

export function LabToolbox({ tools, docs }: { tools?: LabTool[]; docs?: DocLink[] }) {
  const links = (docs || []).filter(d => safeUrl(d.url));
  if (!tools?.length && !links.length) return null;
  return (
    <details className={styles.toolbox}>
      <summary>Toolbox: what you'll need</summary>
      {tools?.map((tool, i) => (
        <div key={i} className={styles.tool}>
          <b>{tool.name}</b> <span className={styles.muted}>{tool.use}</span>
          {tool.code && <pre className={styles.code}><code>{tool.code}</code></pre>}
        </div>
      ))}
      {links.length > 0 && (
        <div className={styles.docs}>
          <b>Read more</b>
          <ul>
            {links.map((d, i) => (
              <li key={i}><a href={d.url} target="_blank" rel="noopener noreferrer">{d.label}</a></li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
