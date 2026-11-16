import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from '../pages/Study.module.css';

// Chat images are squeezed to the bubble width, so a diagram is unreadable there.
// Tap one to open it full screen; tap anywhere or press Escape to close. The
// overlay is portalled to <body> so it sits above the expanded panel (z 150).
export function ChatImage({ src, alt }: { src?: string; alt: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!src) return null;
  return (
    <>
      <button type="button" className={styles.chatImgBtn} onClick={() => setOpen(true)} aria-label={alt ? `Expand image: ${alt}` : 'Expand image'}>
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {open && createPortal(
        <div className={styles.chatImgOverlay} role="dialog" aria-modal="true" aria-label={alt || 'Image'} onClick={() => setOpen(false)}>
          <img src={src} alt={alt} />
          <span className={styles.chatImgHint}>Tap anywhere to close</span>
        </div>,
        document.body,
      )}
    </>
  );
}
