// Oracle API client
// Use /api prefix for Vite proxy
const API_BASE = '/api';

export interface Document {
  id: string;
  type: 'principle' | 'learning' | 'retro';
  content: string;
  source_file: string;
  concepts: string[];
  source?: string;
  created_at?: string;
}

export interface SearchResult {
  results: Document[];
  total: number;
  query: string;
}

export interface ConsultResult {
  decision: string;
  principles: Document[];
  patterns: Document[];
  guidance: string;
}

export interface Stats {
  total: number;
  by_type?: {
    learning: number;
    principle: number;
    retro: number;
  };
  last_indexed?: string;
  is_stale?: boolean;
}

// Search the knowledge base
export async function search(query: string, type: string = 'all', limit: number = 20): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query, type, limit: String(limit) });
  const res = await fetch(`${API_BASE}/search?${params}`);
  return res.json();
}

// List/browse documents
export async function list(type: string = 'all', limit: number = 20, offset: number = 0): Promise<{ results: Document[]; total: number }> {
  const params = new URLSearchParams({ type, limit: String(limit), offset: String(offset) });
  const res = await fetch(`${API_BASE}/list?${params}`);
  return res.json();
}

// Get consultation guidance
export async function consult(decision: string, context?: string): Promise<ConsultResult> {
  const params = new URLSearchParams({ q: decision });
  if (context) params.append('context', context);
  const res = await fetch(`${API_BASE}/consult?${params}`);
  return res.json();
}

// Get stats
export async function getStats(): Promise<Stats> {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

// Get random wisdom
export async function reflect(): Promise<Document> {
  const res = await fetch(`${API_BASE}/reflect`);
  return res.json();
}

// Add new learning
export async function learn(pattern: string, concepts: string[]): Promise<{ success: boolean; id?: string }> {
  const res = await fetch(`${API_BASE}/learn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern, concepts })
  });
  return res.json();
}

// Get graph data
export async function getGraph(): Promise<{ nodes: any[]; links: any[] }> {
  const res = await fetch(`${API_BASE}/graph`);
  return res.json();
}

// Get full file content by source_file path
export async function getFile(path: string): Promise<{ path: string; content: string; error?: string }> {
  const params = new URLSearchParams({ path });
  const res = await fetch(`${API_BASE}/file?${params}`);
  return res.json();
}
