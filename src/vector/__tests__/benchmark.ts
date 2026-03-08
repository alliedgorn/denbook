/**
 * Vector DB Benchmark: ChromaDB vs LanceDB vs Qdrant
 *
 * Compares indexing speed, query latency, filtered queries, and result quality.
 * Run: bun run src/vector/__tests__/benchmark.ts
 */

import { createVectorStore } from '../factory.ts';
import type { VectorStoreAdapter, VectorDocument } from '../types.ts';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ============================================================================
// Test Corpus — 30 documents (mix of types)
// ============================================================================

const DOCS: VectorDocument[] = [
  // Principles (10)
  { id: 'p1', document: 'Nothing is deleted. Create new, do not delete. Git history is sacred. Every commit is permanent.', metadata: { type: 'principle', source_file: 'resonance/nothing-deleted.md' } },
  { id: 'p2', document: 'Patterns over intentions. Watch what the code actually does, not what the PR description claims.', metadata: { type: 'principle', source_file: 'resonance/patterns.md' } },
  { id: 'p3', document: 'External brain, not command. Mirror reality. Present options. Let the human decide.', metadata: { type: 'principle', source_file: 'resonance/external-brain.md' } },
  { id: 'p4', document: 'Curiosity creates existence. Every search creates knowledge. Questions are never wasted.', metadata: { type: 'principle', source_file: 'resonance/curiosity.md' } },
  { id: 'p5', document: 'Form and formless. 191+ Oracles share the same 5 Principles. Each has different purpose.', metadata: { type: 'principle', source_file: 'resonance/form-formless.md' } },
  { id: 'p6', document: 'Oracle never pretends to be human. When AI speaks as itself, there is distinction — but that distinction IS unity.', metadata: { type: 'principle', source_file: 'resonance/transparency.md' } },
  { id: 'p7', document: 'Small enough to understand. If it takes more than 8 minutes to grok, it is too complex.', metadata: { type: 'principle', source_file: 'resonance/small-enough.md' } },
  { id: 'p8', document: 'Cold God Architecture. Build systems that are rules-based, indifferent, incorruptible.', metadata: { type: 'principle', source_file: 'resonance/cold-god.md' } },
  { id: 'p9', document: 'Skills over features. Do not add features to codebases. Add skills — transformations that modify source code.', metadata: { type: 'principle', source_file: 'resonance/skills-over-features.md' } },
  { id: 'p10', document: 'Haiku reads, Opus writes. 90% of work is cheap data gathering. 10% is quality synthesis.', metadata: { type: 'principle', source_file: 'resonance/haiku-reads.md' } },

  // Learnings (10)
  { id: 'l1', document: 'TypeScript Hono API with SQLite FTS5 for full text search. Ground truth in markdown files.', metadata: { type: 'learning', source_file: 'learnings/hono-fts5.md' } },
  { id: 'l2', document: 'ChromaDB vector embeddings for semantic similarity search with all-MiniLM-L6-v2 model.', metadata: { type: 'learning', source_file: 'learnings/chromadb.md' } },
  { id: 'l3', document: 'Qdrant is cloud-native vector DB with payload filtering. Uses cosine distance metric.', metadata: { type: 'learning', source_file: 'learnings/qdrant.md' } },
  { id: 'l4', document: 'LanceDB is serverless columnar vector DB. Stores data as Lance files on disk. No server needed.', metadata: { type: 'learning', source_file: 'learnings/lancedb.md' } },
  { id: 'l5', document: 'Thai text tokenizes at 2-3x more tokens per character than English. Safe truncation: 2000 characters.', metadata: { type: 'learning', source_file: 'learnings/thai-truncation.md' } },
  { id: 'l6', document: 'pm2 does not reliably pass env vars through --update-env. Inline them in the command string.', metadata: { type: 'learning', source_file: 'learnings/pm2-env.md' } },
  { id: 'l7', document: 'Separate frontend from backend cleanly. oracle-studio is its own server with API proxy.', metadata: { type: 'learning', source_file: 'learnings/frontend-separation.md' } },
  { id: 'l8', document: 'Ollama nomic-embed-text produces 768-dimension vectors. GPU accelerated on Apple Silicon.', metadata: { type: 'learning', source_file: 'learnings/ollama-embeddings.md' } },
  { id: 'l9', document: 'MCP protocol bridges allow Claude to interact with external tools like databases and APIs.', metadata: { type: 'learning', source_file: 'learnings/mcp-bridge.md' } },
  { id: 'l10', document: 'Pluggable vector adapter pattern: factory + env var swaps entire vector DB engine at runtime.', metadata: { type: 'learning', source_file: 'learnings/pluggable-adapter.md' } },

  // Retros (10)
  { id: 'r1', document: 'Session 8 built pluggable vector DB adapters. 6 adapters, 4 embedding providers, 190 tests passing.', metadata: { type: 'retro', source_file: 'retros/session-8.md' } },
  { id: 'r2', document: 'Session 9 deployed oracle-v2 on white.local. Qdrant Docker, Ollama embeddings, 22400 vectors indexed.', metadata: { type: 'retro', source_file: 'retros/session-9.md' } },
  { id: 'r3', document: 'Caddy reverse proxy for HTTPS on LAN was too complex. HTTP on a memorable port is simpler.', metadata: { type: 'retro', source_file: 'retros/caddy-lesson.md' } },
  { id: 'r4', document: 'Consultations feature was dead since February. Traced remnants across two repos and cleaned.', metadata: { type: 'retro', source_file: 'retros/consultations-cleanup.md' } },
  { id: 'r5', document: 'Missing connect() call in indexer caused silent fallback to SQLite-only mode. Always connect first.', metadata: { type: 'retro', source_file: 'retros/connect-bug.md' } },
  { id: 'r6', document: 'React dashboard with Recharts for activity visualization. Line chart, tabs, period selector.', metadata: { type: 'retro', source_file: 'retros/dashboard.md' } },
  { id: 'r7', document: 'Knowledge map using UMAP dimensionality reduction from 768-dim vectors to 2D scatter plot.', metadata: { type: 'retro', source_file: 'retros/knowledge-map.md' } },
  { id: 'r8', document: 'Air quality monitoring with PM2.5 sensors across 1500+ stations. 3.24 billion records in InfluxDB.', metadata: { type: 'retro', source_file: 'retros/air-quality.md' } },
  { id: 'r9', document: 'Flood monitoring with ±2mm radar accuracy. Real-time water level tracking on JIBCHAIN L1 blockchain.', metadata: { type: 'retro', source_file: 'retros/flood-monitoring.md' } },
  { id: 'r10', document: 'ESP32 LoRa Meshtastic mesh network for sensor data relay in remote areas without WiFi coverage.', metadata: { type: 'retro', source_file: 'retros/meshtastic.md' } },
];

const QUERIES = [
  'git history preservation and immutable records',
  'vector database semantic search comparison',
  'Thai language text processing and tokenization',
  'deploying web applications on local network',
  'air quality sensor monitoring system',
  'blockchain flood monitoring',
  'React dashboard visualization',
  'AI embedding models and dimensions',
  'Oracle philosophy principles',
  'pluggable adapter factory pattern',
];

const FILTERED_QUERIES = [
  { text: 'vector search technology', where: { type: 'learning' } },
  { text: 'session deployment and infrastructure', where: { type: 'retro' } },
  { text: 'code architecture principles', where: { type: 'principle' } },
];

// ============================================================================
// Helpers
// ============================================================================

async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - start) };
}

function avg(nums: number[]): number {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

interface BenchResult {
  name: string;
  dims: number;
  indexMs: number;
  queryMs: number[];
  queryAvgMs: number;
  filteredMs: number[];
  filteredAvgMs: number;
  topResults: Record<string, string[]>; // query -> top 3 IDs
}

// ============================================================================
// Benchmark Runner
// ============================================================================

async function benchAdapter(
  name: string,
  store: VectorStoreAdapter,
  dims: number,
): Promise<BenchResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Benchmarking: ${name} (${dims}-dim)`);
  console.log(`${'='.repeat(60)}`);

  // Connect + setup
  await store.connect();
  try { await store.deleteCollection(); } catch {}
  await store.ensureCollection();

  // Index benchmark
  console.log(`  Indexing ${DOCS.length} documents...`);
  const { ms: indexMs } = await time(() => store.addDocuments(DOCS));
  console.log(`  Indexed in ${indexMs}ms`);

  // Wait for eventual consistency (Qdrant)
  if (name === 'Qdrant') await new Promise(r => setTimeout(r, 500));

  // Query benchmark
  const queryMs: number[] = [];
  const topResults: Record<string, string[]> = {};

  for (const q of QUERIES) {
    const { result, ms } = await time(() => store.query(q, 3));
    queryMs.push(ms);
    topResults[q] = result.ids.slice(0, 3);
  }
  console.log(`  Query avg: ${avg(queryMs)}ms (${queryMs.join(', ')})`);

  // Filtered query benchmark
  const filteredMs: number[] = [];
  for (const fq of FILTERED_QUERIES) {
    const { ms } = await time(() => store.query(fq.text, 5, fq.where));
    filteredMs.push(ms);
  }
  console.log(`  Filtered avg: ${avg(filteredMs)}ms (${filteredMs.join(', ')})`);

  // Cleanup
  await store.deleteCollection();
  await store.close();

  return {
    name,
    dims,
    indexMs,
    queryMs,
    queryAvgMs: avg(queryMs),
    filteredMs,
    filteredAvgMs: avg(filteredMs),
    topResults,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('Vector DB Benchmark: ChromaDB vs LanceDB vs Qdrant');
  console.log(`Corpus: ${DOCS.length} docs, ${QUERIES.length} queries, ${FILTERED_QUERIES.length} filtered queries`);
  console.log(`Machine: ${os.hostname()} (${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB RAM)`);

  const results: BenchResult[] = [];

  // Check service availability
  const ollamaOk = await fetch('http://localhost:11434/api/tags').then(r => r.ok).catch(() => false);
  const qdrantOk = await fetch('http://localhost:6333/collections').then(r => r.ok).catch(() => false);

  if (!ollamaOk) {
    console.error('ERROR: Ollama not running. LanceDB and Qdrant need it for embeddings.');
    process.exit(1);
  }

  // 1. LanceDB (Ollama, 768-dim)
  {
    const tmpDir = path.join(os.tmpdir(), `oracle-bench-lance-${Date.now()}`);
    const store = createVectorStore({
      type: 'lancedb',
      dataPath: tmpDir,
      collectionName: 'oracle_bench_lance',
      embeddingProvider: 'ollama',
    });
    try {
      results.push(await benchAdapter('LanceDB', store, 768));
    } catch (e) {
      console.error('LanceDB failed:', e);
    }
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }

  // 2. Qdrant (Ollama, 768-dim)
  if (qdrantOk) {
    const store = createVectorStore({
      type: 'qdrant',
      collectionName: 'oracle_bench_qdrant',
      embeddingProvider: 'ollama',
    });
    try {
      results.push(await benchAdapter('Qdrant', store, 768));
    } catch (e) {
      console.error('Qdrant failed:', e);
    }
  } else {
    console.log('\n  [SKIP] Qdrant not available at :6333');
  }

  // 3. ChromaDB (internal embeddings, 384-dim)
  {
    const store = createVectorStore({
      type: 'chroma',
      collectionName: 'oracle_bench_chroma',
    });
    try {
      results.push(await benchAdapter('ChromaDB', store, 384));
    } catch (e) {
      console.error('ChromaDB failed:', e);
    }
  }

  // ============================================================================
  // Results Table
  // ============================================================================

  if (results.length === 0) {
    console.error('\nNo adapters completed successfully.');
    process.exit(1);
  }

  console.log('\n\n' + '='.repeat(70));
  console.log('  RESULTS');
  console.log('='.repeat(70));

  // Summary table
  const header = `| Metric | ${results.map(r => r.name).join(' | ')} |`;
  const sep = `|--------|${results.map(() => '--------').join('|')}|`;
  const rows = [
    `| Embedding dims | ${results.map(r => String(r.dims)).join(' | ')} |`,
    `| Index ${DOCS.length} docs | ${results.map(r => `${r.indexMs}ms`).join(' | ')} |`,
    `| Query avg (${QUERIES.length}q) | ${results.map(r => `${r.queryAvgMs}ms`).join(' | ')} |`,
    `| Filtered avg (${FILTERED_QUERIES.length}q) | ${results.map(r => `${r.filteredAvgMs}ms`).join(' | ')} |`,
  ];

  console.log('\n' + [header, sep, ...rows].join('\n'));

  // Query-by-query breakdown
  console.log('\n\n--- Query Latency Breakdown (ms) ---\n');
  const qHeader = `| Query | ${results.map(r => r.name).join(' | ')} |`;
  const qSep = `|-------|${results.map(() => '------').join('|')}|`;
  const qRows = QUERIES.map((q, i) => {
    const short = q.length > 40 ? q.slice(0, 37) + '...' : q;
    return `| ${short} | ${results.map(r => `${r.queryMs[i] ?? '-'}ms`).join(' | ')} |`;
  });
  console.log([qHeader, qSep, ...qRows].join('\n'));

  // Top results comparison
  console.log('\n\n--- Top-3 Results by Query ---\n');
  for (const q of QUERIES.slice(0, 5)) {
    console.log(`\n"${q}":`);
    for (const r of results) {
      const ids = r.topResults[q] || [];
      console.log(`  ${r.name.padEnd(10)}: ${ids.join(', ')}`);
    }
  }

  console.log('\n\nDone.');
}

main().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
