import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from '../pages/Study.module.css';
import { announceImage, openAskKaro } from './imageView';

// Chat images are squeezed to the bubble width, so a diagram is unreadable there.
// Tap one to open it full screen; tap anywhere or press Escape to close. The
// overlay is portalled to <body> so it sits above the expanded panel (150) and the DM chat overlay (9000).
// On a wide screen, Ask Karo docks to the right of the picture (above this overlay),
// so Gorn can look and ask at the same time; the overlay leaves that strip free.
export function ChatImage({ src, alt }: { src?: string; alt: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    announceImage(alt || 'picture');
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape while typing a question in Ask Karo should not close the picture.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); announceImage(null); };
  }, [open, alt]);
  if (!src) return null;
  return (
    <>
      <button type="button" className={styles.chatImgBtn} onClick={() => setOpen(true)} aria-label={alt ? `Expand image: ${alt}` : 'Expand image'}>
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {open && createPortal(
        <div className={styles.chatImgOverlay} role="dialog" aria-modal="true" aria-label={alt || 'Image'} onClick={() => setOpen(false)}>
          <img src={src} alt={alt} />
          <span className={styles.chatImgHint}>
            Tap anywhere to close
            <button type="button" className={styles.chatImgAsk} onClick={e => { e.stopPropagation(); openAskKaro(); }}>
              🦴 Ask Karo about this
            </button>
          </span>
        </div>,
        document.body,
      )}
    </>
  );
}
