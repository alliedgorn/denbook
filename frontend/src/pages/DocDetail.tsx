import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { search, list, getFile } from '../api/oracle';
import type { Document } from '../api/oracle';
import styles from './DocDetail.module.css';

interface LocationState {
  doc?: Document;
  docs?: Document[];
  currentIndex?: number;
}

export function DocDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [doc, setDoc] = useState<Document | null>(null);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<{ prev: Document | null; next: Document | null }>({ prev: null, next: null });

  // Navigate to a document
  const goToDoc = useCallback((targetDoc: Document) => {
    navigate(`/doc/${encodeURIComponent(targetDoc.id)}`, { state: { doc: targetDoc } });
  }, [navigate]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'j' && neighbors.next) {
        goToDoc(neighbors.next);
      } else if (e.key === 'k' && neighbors.prev) {
        goToDoc(neighbors.prev);
      } else if (e.key === 'u') {
        navigate(-1);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [neighbors, goToDoc, navigate]);

  // Load full content from file
  useEffect(() => {
    async function loadFullContent() {
      if (!doc?.source_file) return;

      try {
        const fileData = await getFile(doc.source_file);
        if (fileData.content) {
          setFullContent(fileData.content);
        }
      } catch (e) {
        console.error('Failed to load full content:', e);
      }
    }

    setFullContent(null); // Reset when doc changes
    loadFullContent();
  }, [doc]);

  // Load neighbors (prev/next documents)
  useEffect(() => {
    async function loadNeighbors() {
      if (!doc) return;

      try {
        // Check if docs list was passed via state
        const state = location.state as LocationState;
        if (state?.docs && state.currentIndex !== undefined) {
          const idx = state.currentIndex;
          setNeighbors({
            prev: idx > 0 ? state.docs[idx - 1] : null,
            next: idx < state.docs.length - 1 ? state.docs[idx + 1] : null
          });
          return;
        }

        // Otherwise fetch from API
        const data = await list(doc.type, 100, 0);
        const idx = data.results.findIndex(d => d.id === doc.id);
        if (idx !== -1) {
          setNeighbors({
            prev: idx > 0 ? data.results[idx - 1] : null,
            next: idx < data.results.length - 1 ? data.results[idx + 1] : null
          });
        }
      } catch (e) {
        console.error('Failed to load neighbors:', e);
      }
    }

    loadNeighbors();
  }, [doc, location.state]);

  useEffect(() => {
    // Check if document was passed via router state
    const state = location.state as LocationState;
    if (state?.doc) {
      setDoc(state.doc);
      setLoading(false);
      return;
    }

    // Otherwise, search for the document
    loadDoc();
  }, [id, location.state]);

  async function loadDoc() {
    if (!id) return;
    setLoading(true);
    setError(null);

    try {
      const decodedId = decodeURIComponent(id);

      // Extract meaningful search terms from the ID
      // ID format: type_date_slug (e.g., learning_2026-01-03_the-oracle-keeps...)
      const parts = decodedId.split('_');
      const slugPart = parts.slice(2).join(' ').replace(/-/g, ' ');

      // Try multiple search strategies
      const searchTerms = [
        slugPart,                           // "oracle v2 dashboard urls..."
        parts.slice(2).join('-'),           // "oracle-v2-dashboard-urls..."
        decodedId,                          // full ID
        slugPart.split(' ').slice(0, 4).join(' ') // first 4 words
      ].filter(Boolean);

      let foundDoc = null;

      for (const searchTerm of searchTerms) {
        if (foundDoc) break;

        const data = await search(searchTerm, 'all', 50);

        // Find exact match first
        foundDoc = data.results.find(r => r.id === decodedId);

        // Fallback: find by partial ID match
        if (!foundDoc) {
          foundDoc = data.results.find(r =>
            r.id.includes(decodedId) ||
            decodedId.includes(r.id)
          );
        }

        // Fallback: find by slug similarity
        if (!foundDoc && slugPart) {
          foundDoc = data.results.find(r => {
            const rSlug = r.id.split('_').slice(2).join('-');
            return rSlug === parts.slice(2).join('-') ||
                   r.id.includes(parts.slice(2).join('-'));
          });
        }
      }

      if (foundDoc) {
        setDoc(foundDoc);
      } else {
        setError('Document not found');
      }
    } catch (e) {
      setError('Failed to load document');
    } finally {
      setLoading(false);
    }
  }

  // Strip YAML frontmatter only, keep all content
  function stripFrontmatter(content: string): string {
    const trimmed = content.trim();
    if (trimmed.startsWith('---')) {
      const endIndex = trimmed.indexOf('---', 3);
      if (endIndex !== -1) {
        return trimmed.slice(endIndex + 3).trim();
      }
    }
    return trimmed;
  }

  // Try to format a date string, return null if invalid
  function tryFormatDate(dateStr: string): string | null {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return null;
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return null;
    }
  }

  // Extract metadata
  function parseMetadata(doc: Document) {
    const source = doc.source_file || '';
    const content = doc.content || '';

    let when = 'Unknown date';

    // 1. Try YYYY-MM-DD pattern in source_file
    const isoDateMatch = source.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoDateMatch) {
      const formatted = tryFormatDate(isoDateMatch[1]);
      if (formatted) when = formatted;
    }

    // 2. Try YYYY/MM/DD path pattern
    if (when === 'Unknown date') {
      const pathDateMatch = source.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (pathDateMatch) {
        const formatted = tryFormatDate(`${pathDateMatch[1]}-${pathDateMatch[2]}-${pathDateMatch[3]}`);
        if (formatted) when = formatted;
      }
    }

    // 3. Try YYYY-MM/DD path pattern
    if (when === 'Unknown date') {
      const altPathMatch = source.match(/(\d{4})-(\d{2})\/(\d{2})/);
      if (altPathMatch) {
        const formatted = tryFormatDate(`${altPathMatch[1]}-${altPathMatch[2]}-${altPathMatch[3]}`);
        if (formatted) when = formatted;
      }
    }

    // 4. Try doc.id for date pattern
    if (when === 'Unknown date' && doc.id) {
      const idDateMatch = doc.id.match(/(\d{4}-\d{2}-\d{2})/);
      if (idDateMatch) {
        const formatted = tryFormatDate(idDateMatch[1]);
        if (formatted) when = formatted;
      }
    }

    // 5. Try to extract date from content (e.g., "Date: 2026-01-02")
    if (when === 'Unknown date') {
      const contentDateMatch = content.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
      if (contentDateMatch) {
        const formatted = tryFormatDate(contentDateMatch[1]);
        if (formatted) when = formatted;
      }
    }

    const what = doc.type.charAt(0).toUpperCase() + doc.type.slice(1);

    const how = source.includes('resonance') ? 'From Resonance Profile'
      : source.includes('retrospective') ? 'From Session Retrospective'
      : source.includes('learnings') ? 'From Discoveries'
      : 'From Knowledge Base';

    return { when, what, how };
  }

  if (loading) {
    return <div className={styles.loading}>Loading...</div>;
  }

  if (error || !doc) {
    return (
      <div className={styles.error}>
        <p>{error || 'Document not found'}</p>
        <button onClick={() => navigate(-1)} className={styles.backBtn}>
          Go Back
        </button>
      </div>
    );
  }

  const { when, what, how } = parseMetadata(doc);

  return (
    <article className={styles.container}>
      <button onClick={() => navigate(-1)} className={styles.backLink}>
        ← Back to Feed
      </button>

      <header className={styles.header}>
        <div className={styles.meta}>
          <span className={styles.type}>{what}</span>
          <span className={styles.dot}>·</span>
          <span className={styles.when}>{when}</span>
        </div>

        <p className={styles.source}>{how}</p>
      </header>

      <div className={styles.content}>
        <Markdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(fullContent || doc.content)}</Markdown>
      </div>

      {doc.concepts && doc.concepts.length > 0 && (
        <div className={styles.tagsSection}>
          <h3 className={styles.tagsTitle}>Related Concepts</h3>
          <div className={styles.tags}>
            {doc.concepts.map(tag => (
              <Link key={tag} to={`/search?q=${encodeURIComponent(tag)}`} className={styles.tag}>
                {tag}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Navigation */}
      {(neighbors.prev || neighbors.next) && (
        <nav className={styles.navigation}>
          <button
            onClick={() => neighbors.prev && goToDoc(neighbors.prev)}
            disabled={!neighbors.prev}
            className={styles.navBtn}
          >
            <span className={styles.navKey}>K</span>
            <span className={styles.navLabel}>Previous</span>
          </button>
          <span className={styles.navHint}>J/K navigate · U back</span>
          <button
            onClick={() => neighbors.next && goToDoc(neighbors.next)}
            disabled={!neighbors.next}
            className={styles.navBtn}
          >
            <span className={styles.navLabel}>Next</span>
            <span className={styles.navKey}>J</span>
          </button>
        </nav>
      )}

      <footer className={styles.footer}>
        <p className={styles.sourcePath}>{doc.source_file}</p>
      </footer>
    </article>
  );
}
