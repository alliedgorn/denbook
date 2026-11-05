import type { Block, Inline } from './types';
import styles from '../pages/Study.module.css';

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
        return <div key={i} className={styles.tip}><Inlines parts={blk.tip} /></div>;
      })}
    </>
  );
}
