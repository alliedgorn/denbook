import type { Block, Inline } from './types';
import styles from '../pages/Study.module.css';
import { ChatImage } from './ChatImage';

// Renders typed content blocks as React elements. Every string goes through
// React's text escaping — there is deliberately no HTML path here.

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((x, i) => {
        if (typeof x === 'string') return <span key={i}>{x}</span>;
        if ('b' in x) return <b key={i}>{x.b}</b>;
        return <span key={i} className={styles.term}>{x.term}</span>;
      })}
    </>
  );
}

export function RichText({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((blk, i) => {
        if ('p' in blk) return <p key={i}><Inlines parts={blk.p} /></p>;
        if ('ul' in blk) {
          return (
            <ul key={i}>
              {blk.ul.map((li, j) => <li key={j}><Inlines parts={li} /></li>)}
            </ul>
          );
        }
        if ('code' in blk) return <pre key={i} className={styles.code}><code>{blk.code}</code></pre>;
        if ('img' in blk) {
          // src was checked by contentGuard (same-origin /api/f/ only). Tap to open full size.
          return (
            <figure key={i} className={styles.figure}>
              <ChatImage src={blk.img} alt={blk.alt} />
              {blk.caption && <figcaption>{blk.caption}</figcaption>}
            </figure>
          );
        }
        return <div key={i} className={styles.tip}><Inlines parts={blk.tip} /></div>;
      })}
    </>
  );
}
