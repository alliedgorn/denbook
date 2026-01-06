import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import styles from './Decisions.module.css';

type DecisionStatus = 'pending' | 'parked' | 'researching' | 'decided' | 'implemented' | 'closed';

interface DecisionOption {
  label: string;
  pros: string[];
  cons: string[];
}

interface Decision {
  id: number;
  title: string;
  status: DecisionStatus;
  context: string | null;
  options: DecisionOption[] | null;
  decision: string | null;
  rationale: string | null;
  project: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface DecisionCounts {
  pending: number;
  parked: number;
  researching: number;
  decided: number;
  implemented: number;
  closed: number;
}

const API_BASE = '/api';

async function fetchDecisions(status?: string): Promise<{ decisions: Decision[]; total: number; counts: DecisionCounts }> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.append('status', status);
  const res = await fetch(`${API_BASE}/decisions?${params}`);
  return res.json();
}

async function fetchDecision(id: number): Promise<Decision> {
  const res = await fetch(`${API_BASE}/decisions/${id}`);
  return res.json();
}

async function createDecision(data: {
  title: string;
  context?: string;
  options?: DecisionOption[];
  tags?: string[];
}): Promise<Decision> {
  const res = await fetch(`${API_BASE}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function updateDecision(id: number, data: {
  title?: string;
  context?: string;
  options?: DecisionOption[];
  decision?: string;
  rationale?: string;
  tags?: string[];
  status?: DecisionStatus;
  decided_by?: string;
}): Promise<Decision> {
  const res = await fetch(`${API_BASE}/decisions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function transitionDecision(id: number, status: DecisionStatus, decidedBy?: string): Promise<Decision> {
  const res = await fetch(`${API_BASE}/decisions/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, decided_by: decidedBy })
  });
  return res.json();
}

export function Decisions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [counts, setCounts] = useState<DecisionCounts>({ pending: 0, parked: 0, researching: 0, decided: 0, implemented: 0, closed: 0 });
  const [selectedDecision, setSelectedDecision] = useState<Decision | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [loading, setLoading] = useState(false);

  // New decision form
  const [newTitle, setNewTitle] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newTags, setNewTags] = useState('');

  // Edit form
  const [editDecision, setEditDecision] = useState('');
  const [editRationale, setEditRationale] = useState('');

  const decisionIdParam = searchParams.get('decision');
  const showNew = searchParams.get('new') === 'true';

  useEffect(() => {
    loadDecisions();
  }, [statusFilter]);

  // Load decision from URL param or auto-select first
  useEffect(() => {
    if (decisionIdParam) {
      selectDecision(parseInt(decisionIdParam, 10));
    } else if (decisions.length > 0 && !showNew) {
      // Auto-select first decision
      setSearchParams({ decision: decisions[0].id.toString() });
    } else {
      setSelectedDecision(null);
    }
  }, [decisionIdParam, decisions]);

  async function loadDecisions() {
    const data = await fetchDecisions(statusFilter);
    setDecisions(data.decisions);
    setCounts(data.counts);
  }

  async function selectDecision(id: number) {
    const data = await fetchDecision(id);
    setSelectedDecision(data);
    setEditDecision(data.decision || '');
    setEditRationale(data.rationale || '');
    setSearchParams({ decision: id.toString() });
  }

  function openNewDecision() {
    setSearchParams({ new: 'true' });
    setSelectedDecision(null);
    setNewTitle('');
    setNewContext('');
    setNewTags('');
  }

  async function handleCreateDecision(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setLoading(true);
    try {
      const tags = newTags.split(',').map(t => t.trim()).filter(Boolean);
      const result = await createDecision({
        title: newTitle,
        context: newContext || undefined,
        tags: tags.length > 0 ? tags : undefined
      });
      await loadDecisions();
      setSearchParams({ decision: result.id.toString() });
    } finally {
      setLoading(false);
    }
  }

  async function handleMakeDecision(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDecision || !editDecision.trim()) return;

    setLoading(true);
    try {
      await updateDecision(selectedDecision.id, {
        decision: editDecision,
        rationale: editRationale || undefined,
        status: 'decided',
        decided_by: 'user'
      });
      await selectDecision(selectedDecision.id);
      await loadDecisions();
    } finally {
      setLoading(false);
    }
  }

  async function handleTransition(newStatus: DecisionStatus) {
    if (!selectedDecision) return;

    setLoading(true);
    try {
      await transitionDecision(selectedDecision.id, newStatus);
      await selectDecision(selectedDecision.id);
      await loadDecisions();
    } catch (err) {
      console.error('Failed to transition:', err);
      alert('Invalid status transition');
    } finally {
      setLoading(false);
    }
  }

  function getStatusColor(status: DecisionStatus): string {
    switch (status) {
      case 'pending': return '#f59e0b';
      case 'parked': return '#6b7280';
      case 'researching': return '#3b82f6';
      case 'decided': return '#10b981';
      case 'implemented': return '#8b5cf6';
      case 'closed': return '#4b5563';
      default: return '#6b7280';
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  const statusTabs: { key: string; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: `Pending (${counts.pending})` },
    { key: 'parked', label: `Parked (${counts.parked})` },
    { key: 'researching', label: `Researching (${counts.researching})` },
    { key: 'decided', label: `Decided (${counts.decided})` },
    { key: 'implemented', label: `Implemented (${counts.implemented})` },
  ];

  return (
    <div className={styles.container}>
      {/* Sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>Decisions</h2>
          <button className={styles.newButton} onClick={openNewDecision}>
            + New
          </button>
        </div>

        <div className={styles.statusTabs}>
          {statusTabs.map(tab => (
            <button
              key={tab.key}
              className={`${styles.statusTab} ${statusFilter === tab.key ? styles.active : ''}`}
              onClick={() => setStatusFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={styles.decisionList}>
          {decisions.map(decision => (
            <div
              key={decision.id}
              className={`${styles.decisionItem} ${selectedDecision?.id === decision.id ? styles.active : ''}`}
              onClick={() => setSearchParams({ decision: decision.id.toString() })}
            >
              <div className={styles.decisionTitle}>{decision.title}</div>
              <div className={styles.decisionMeta}>
                <span
                  className={styles.status}
                  style={{ backgroundColor: getStatusColor(decision.status) }}
                >
                  {decision.status}
                </span>
                {decision.tags && decision.tags.length > 0 && (
                  <span className={styles.tags}>
                    {decision.tags.slice(0, 2).join(', ')}
                  </span>
                )}
              </div>
            </div>
          ))}

          {decisions.length === 0 && (
            <div className={styles.empty}>No decisions found</div>
          )}
        </div>
      </div>

      {/* Main Panel */}
      <div className={styles.main}>
        {/* New Decision Form */}
        {showNew && !selectedDecision && (
          <div className={styles.newDecision}>
            <h2>New Decision</h2>
            <form onSubmit={handleCreateDecision} className={styles.form}>
              <input
                type="text"
                placeholder="Decision title *"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                className={styles.input}
                required
              />
              <textarea
                placeholder="Context - Why does this decision matter?"
                value={newContext}
                onChange={e => setNewContext(e.target.value)}
                className={styles.textarea}
                rows={4}
              />
              <input
                type="text"
                placeholder="Tags (comma-separated)"
                value={newTags}
                onChange={e => setNewTags(e.target.value)}
                className={styles.input}
              />
              <button
                type="submit"
                disabled={loading || !newTitle.trim()}
                className={styles.submitButton}
              >
                {loading ? 'Creating...' : 'Create Decision'}
              </button>
            </form>
          </div>
        )}

        {/* Decision Detail */}
        {selectedDecision && (
          <div className={styles.decisionDetail}>
            <div className={styles.detailHeader}>
              <h2>{selectedDecision.title}</h2>
              <span
                className={styles.statusBadge}
                style={{ backgroundColor: getStatusColor(selectedDecision.status) }}
              >
                {selectedDecision.status}
              </span>
            </div>

            <div className={styles.detailMeta}>
              <span>Created: {formatDate(selectedDecision.created_at)}</span>
              {selectedDecision.project && (
                <span>Project: {selectedDecision.project}</span>
              )}
              {selectedDecision.decided_at && (
                <span>Decided: {formatDate(selectedDecision.decided_at)} by {selectedDecision.decided_by}</span>
              )}
            </div>

            {selectedDecision.tags && selectedDecision.tags.length > 0 && (
              <div className={styles.tagList}>
                {selectedDecision.tags.map(tag => (
                  <span key={tag} className={styles.tag}>{tag}</span>
                ))}
              </div>
            )}

            {selectedDecision.context && (
              <div className={styles.section}>
                <h3>Context</h3>
                <p className={styles.context}>{selectedDecision.context}</p>
              </div>
            )}

            {selectedDecision.options && selectedDecision.options.length > 0 && (
              <div className={styles.section}>
                <h3>Options</h3>
                <div className={styles.optionsList}>
                  {selectedDecision.options.map((opt, i) => (
                    <div key={i} className={styles.option}>
                      <div className={styles.optionLabel}>{opt.label}</div>
                      <div className={styles.prosConsGrid}>
                        <div className={styles.pros}>
                          <strong>Pros:</strong>
                          <ul>
                            {opt.pros.map((p, j) => <li key={j}>{p}</li>)}
                          </ul>
                        </div>
                        <div className={styles.cons}>
                          <strong>Cons:</strong>
                          <ul>
                            {opt.cons.map((c, j) => <li key={j}>{c}</li>)}
                          </ul>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedDecision.decision && (
              <div className={styles.section}>
                <h3>Decision</h3>
                <p className={styles.decisionText}>{selectedDecision.decision}</p>
                {selectedDecision.rationale && (
                  <>
                    <h4>Rationale</h4>
                    <p className={styles.rationale}>{selectedDecision.rationale}</p>
                  </>
                )}
              </div>
            )}

            {/* Status Transitions */}
            <div className={styles.section}>
              <h3>Actions</h3>
              <div className={styles.actions}>
                {selectedDecision.status === 'pending' && (
                  <>
                    <button onClick={() => handleTransition('parked')} className={styles.actionButton}>
                      Park
                    </button>
                    <button onClick={() => handleTransition('researching')} className={styles.actionButton}>
                      Start Research
                    </button>
                  </>
                )}
                {selectedDecision.status === 'parked' && (
                  <>
                    <button onClick={() => handleTransition('pending')} className={styles.actionButton}>
                      Reactivate
                    </button>
                    <button onClick={() => handleTransition('researching')} className={styles.actionButton}>
                      Start Research
                    </button>
                  </>
                )}
                {selectedDecision.status === 'researching' && (
                  <>
                    <button onClick={() => handleTransition('parked')} className={styles.actionButton}>
                      Park
                    </button>
                  </>
                )}
                {selectedDecision.status === 'decided' && (
                  <>
                    <button onClick={() => handleTransition('implemented')} className={styles.actionButton}>
                      Mark Implemented
                    </button>
                    <button onClick={() => handleTransition('researching')} className={styles.actionButton}>
                      Reconsider
                    </button>
                  </>
                )}
                {selectedDecision.status === 'implemented' && (
                  <>
                    <button onClick={() => handleTransition('closed')} className={styles.actionButton}>
                      Close
                    </button>
                  </>
                )}
                {selectedDecision.status === 'closed' && (
                  <>
                    <button onClick={() => handleTransition('pending')} className={styles.actionButton}>
                      Reopen
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Make Decision Form (for pending/researching) */}
            {(selectedDecision.status === 'pending' || selectedDecision.status === 'researching') && !selectedDecision.decision && (
              <div className={styles.section}>
                <h3>Make Decision</h3>
                <form onSubmit={handleMakeDecision} className={styles.form}>
                  <input
                    type="text"
                    placeholder="What was decided?"
                    value={editDecision}
                    onChange={e => setEditDecision(e.target.value)}
                    className={styles.input}
                    required
                  />
                  <textarea
                    placeholder="Why this choice? (rationale)"
                    value={editRationale}
                    onChange={e => setEditRationale(e.target.value)}
                    className={styles.textarea}
                    rows={3}
                  />
                  <button
                    type="submit"
                    disabled={loading || !editDecision.trim()}
                    className={styles.submitButton}
                  >
                    {loading ? 'Saving...' : 'Record Decision'}
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {!showNew && !selectedDecision && (
          <div className={styles.placeholder}>
            <p>Select a decision or create a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}
