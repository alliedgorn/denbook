/**
 * ChromaDB MCP Client
 *
 * Uses chroma-mcp (Python) via MCP protocol for embeddings.
 * This avoids the pnpm/npm dynamic import issues with chromadb-default-embed.
 *
 * Pattern learned from claude-mem:
 * JS code → MCP Client → chroma-mcp (Python) → ChromaDB
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

export class ChromaMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private collectionName: string;
  private dataDir: string;
  private pythonVersion: string;

  constructor(collectionName: string, dataDir: string, pythonVersion: string = '3.12') {
    this.collectionName = collectionName;
    this.dataDir = dataDir;
    this.pythonVersion = pythonVersion;
  }

  /**
   * Connect to chroma-mcp server
   */
  async connect(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    console.log('Connecting to chroma-mcp server...');

    try {
      this.transport = new StdioClientTransport({
        command: 'uvx',
        args: [
          '--python', this.pythonVersion,
          'chroma-mcp',
          '--client-type', 'persistent',
          '--data-dir', this.dataDir
        ],
        stderr: 'ignore'
      });

      this.client = new Client({
        name: 'oracle-v2-indexer',
        version: '1.0.0'
      }, {
        capabilities: {}
      });

      await this.client.connect(this.transport);
      this.connected = true;

      console.log('Connected to chroma-mcp server');
    } catch (error) {
      throw new Error(`Chroma connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure collection exists
   */
  async ensureCollection(): Promise<void> {
    await this.connect();

    if (!this.client) {
      throw new Error('Chroma client not initialized');
    }

    try {
      // Try to get collection info
      await this.client.callTool({
        name: 'chroma_get_collection_info',
        arguments: {
          collection_name: this.collectionName
        }
      });
      console.log(`Collection '${this.collectionName}' exists`);
    } catch {
      // Collection doesn't exist, create it
      console.log(`Creating collection '${this.collectionName}'...`);
      await this.client.callTool({
        name: 'chroma_create_collection',
        arguments: {
          collection_name: this.collectionName,
          embedding_function_name: 'default'
        }
      });
      console.log(`Collection '${this.collectionName}' created`);
    }
  }

  /**
   * Delete collection if exists
   */
  async deleteCollection(): Promise<void> {
    await this.connect();

    if (!this.client) {
      throw new Error('Chroma client not initialized');
    }

    try {
      await this.client.callTool({
        name: 'chroma_delete_collection',
        arguments: {
          collection_name: this.collectionName
        }
      });
      console.log(`Collection '${this.collectionName}' deleted`);
    } catch {
      // Collection doesn't exist, ignore
    }
  }

  /**
   * Add documents to collection
   */
  async addDocuments(documents: ChromaDocument[]): Promise<void> {
    if (documents.length === 0) return;

    await this.ensureCollection();

    if (!this.client) {
      throw new Error('Chroma client not initialized');
    }

    await this.client.callTool({
      name: 'chroma_add_documents',
      arguments: {
        collection_name: this.collectionName,
        documents: documents.map(d => d.document),
        ids: documents.map(d => d.id),
        metadatas: documents.map(d => d.metadata)
      }
    });
  }

  /**
   * Query collection for semantic search
   */
  async query(
    queryText: string,
    limit: number = 10,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: string[]; documents: string[]; distances: number[]; metadatas: any[] }> {
    await this.connect();

    if (!this.client) {
      throw new Error('Chroma client not initialized');
    }

    const args: any = {
      collection_name: this.collectionName,
      query_texts: [queryText],
      n_results: limit,
      include: ['documents', 'metadatas', 'distances']
    };

    if (whereFilter) {
      args.where = JSON.stringify(whereFilter);
    }

    const result = await this.client.callTool({
      name: 'chroma_query_documents',
      arguments: args
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const data = content[0];
    if (data.type !== 'text' || !data.text) {
      throw new Error('Unexpected response type');
    }

    const parsed = JSON.parse(data.text);

    return {
      ids: parsed.ids?.[0] || [],
      documents: parsed.documents?.[0] || [],
      distances: parsed.distances?.[0] || [],
      metadatas: parsed.metadatas?.[0] || []
    };
  }

  /**
   * Get collection stats
   */
  async getStats(): Promise<{ count: number }> {
    await this.connect();

    if (!this.client) {
      throw new Error('Chroma client not initialized');
    }

    try {
      const result = await this.client.callTool({
        name: 'chroma_get_collection_info',
        arguments: {
          collection_name: this.collectionName
        }
      });

      const content = result.content as Array<{ type: string; text?: string }>;
      const data = content[0];
      if (data.type !== 'text' || !data.text) {
        return { count: 0 };
      }

      const parsed = JSON.parse(data.text);
      return { count: parsed.count || 0 };
    } catch {
      return { count: 0 };
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors
      }
    }

    this.connected = false;
    this.client = null;
    this.transport = null;
  }
}
