import { Message } from '../knowledge/types';

export interface StorageProvider {
  // Knowledge base operations
  readKnowledge(): Promise<string | null>;
  writeKnowledge(content: string): Promise<void>;
  getKnowledgeMetadata(): Promise<{ 
    lastUpdated: string | null; 
    version: number; 
    lastCollectionTimestamp: string | null; 
  }>;

  // Message collection operations
  readMessages(): Promise<Message[]>;
  writeMessages(messages: Message[]): Promise<void>;
  addMessage(message: Message): Promise<void>;
  clearMessages(): Promise<void>;

  // Collection timestamp tracking
  updateCollectionTimestamp(timestamp: string): Promise<void>;
  getLastCollectionTimestamp(): Promise<string | null>;

  // Initialization
  initialize(): Promise<void>;
}