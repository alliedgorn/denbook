/**
 * Vector Store Factory
 *
 * Creates the right VectorStoreAdapter + EmbeddingProvider from env vars.
 * Defaults to ChromaDB for backward compatibility.
 */

import path from 'path';
import type { VectorStoreAdapter, VectorDBType, EmbeddingProviderType } from './types.ts';
import { ChromaMcpAdapter } from './adapters/chroma-mcp.ts';
import { SqliteVecAdapter } from './adapters/sqlite-vec.ts';
import { LanceDBAdapter } from './adapters/lancedb.ts';
import { QdrantAdapter } from './adapters/qdrant.ts';
import { CloudflareVectorizeAdapter, CloudflareAIEmbeddings } from './adapters/cloudflare-vectorize.ts';
import { createEmbeddingProvider } from './embeddings.ts';

export interface VectorStoreConfig {
  type?: VectorDBType;
  collectionName?: string;
  /** ChromaDB data dir, sqlite-vec DB path, or LanceDB directory */
  dataPath?: string;
  pythonVersion?: string;
  embeddingProvider?: EmbeddingProviderType;
  embeddingModel?: string;
  /** Qdrant URL (default: http://localhost:6333) */
  qdrantUrl?: string;
  /** Qdrant API key */
  qdrantApiKey?: string;
  /** Cloudflare account ID */
  cfAccountId?: string;
  /** Cloudflare API token */
  cfApiToken?: string;
}

/**
 * Create a VectorStoreAdapter from config or env vars.
 *
 * Env vars:
 *   ORACLE_VECTOR_DB          = 'chroma' | 'sqlite-vec' | 'lancedb' | 'qdrant' | 'cloudflare-vectorize'
 *   ORACLE_EMBEDDING_PROVIDER = 'chromadb-internal' | 'ollama' | 'openai' | 'cloudflare-ai'
 *   ORACLE_EMBEDDING_MODEL    = model name override
 *   ORACLE_VECTOR_DB_PATH     = sqlite-vec / lancedb path
 *   CLOUDFLARE_ACCOUNT_ID     = CF account (for cloudflare-vectorize)
 *   CLOUDFLARE_API_TOKEN      = CF API token (for cloudflare-vectorize)
 */
export function createVectorStore(config: VectorStoreConfig = {}): VectorStoreAdapter {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';

  const type = config.type
    || (process.env.ORACLE_VECTOR_DB as VectorDBType)
    || 'chroma';

  const collectionName = config.collectionName || 'oracle_knowledge';

  switch (type) {
    case 'sqlite-vec': {
      const dbPath = config.dataPath
        || process.env.ORACLE_VECTOR_DB_PATH
        || path.join(homeDir, '.oracle', 'vectors.db');

      const embeddingType = config.embeddingProvider
        || (process.env.ORACLE_EMBEDDING_PROVIDER as EmbeddingProviderType)
        || 'ollama';

      const embeddingModel = config.embeddingModel
        || process.env.ORACLE_EMBEDDING_MODEL;

      const embedder = createEmbeddingProvider(embeddingType, embeddingModel);
      return new SqliteVecAdapter(collectionName, dbPath, embedder);
    }

    case 'lancedb': {
      const dbPath = config.dataPath
        || process.env.ORACLE_VECTOR_DB_PATH
        || path.join(homeDir, '.oracle', 'lancedb');

      const embeddingType = config.embeddingProvider
        || (process.env.ORACLE_EMBEDDING_PROVIDER as EmbeddingProviderType)
        || 'ollama';

      const embeddingModel = config.embeddingModel
        || process.env.ORACLE_EMBEDDING_MODEL;

      const embedder = createEmbeddingProvider(embeddingType, embeddingModel);
      return new LanceDBAdapter(collectionName, dbPath, embedder);
    }

    case 'qdrant': {
      const embeddingType = config.embeddingProvider
        || (process.env.ORACLE_EMBEDDING_PROVIDER as EmbeddingProviderType)
        || 'ollama';

      const embeddingModel = config.embeddingModel
        || process.env.ORACLE_EMBEDDING_MODEL;

      const embedder = createEmbeddingProvider(embeddingType, embeddingModel);
      return new QdrantAdapter(collectionName, embedder, {
        url: config.qdrantUrl || process.env.QDRANT_URL,
        apiKey: config.qdrantApiKey || process.env.QDRANT_API_KEY,
      });
    }

    case 'cloudflare-vectorize': {
      const cfConfig = {
        accountId: config.cfAccountId || process.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: config.cfApiToken || process.env.CLOUDFLARE_API_TOKEN,
      };

      const embeddingModel = config.embeddingModel
        || process.env.ORACLE_EMBEDDING_MODEL;

      // Default to Cloudflare AI embeddings (same platform, zero egress)
      const embedder = new CloudflareAIEmbeddings({
        ...cfConfig,
        model: embeddingModel,
      });

      return new CloudflareVectorizeAdapter(collectionName, embedder, cfConfig);
    }

    case 'chroma':
    default: {
      const dataPath = config.dataPath || path.join(homeDir, '.chromadb');
      const pythonVersion = config.pythonVersion || '3.12';
      return new ChromaMcpAdapter(collectionName, dataPath, pythonVersion);
    }
  }
}
