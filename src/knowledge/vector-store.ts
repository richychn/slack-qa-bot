import { Message, KnowledgeStats } from './types';
import { StorageProvider } from '../storage/storage-interface';
import { logger } from '../utils/logger';

export class KnowledgeStore {
  private storageProvider: StorageProvider;
  private knowledgeCache: string = '';
  private lastUpdatedCache: string | null = null;

  constructor(storageProvider: StorageProvider) {
    this.storageProvider = storageProvider;
  }

  // Expose storage provider for collection timestamp operations
  get storage(): StorageProvider {
    return this.storageProvider;
  }

  async initialize(): Promise<void> {
    try {
      await this.storageProvider.initialize();
      
      // Load existing knowledge from storage
      const knowledge = await this.storageProvider.readKnowledge();
      const metadata = await this.storageProvider.getKnowledgeMetadata();
      
      this.knowledgeCache = knowledge || '';
      this.lastUpdatedCache = metadata.lastUpdated;
      
      if (this.knowledgeCache.length > 0) {
        logger.info(`Loaded existing knowledge base: ${this.knowledgeCache.length} characters`);
      } else {
        logger.info('Starting with empty knowledge base');
      }
    } catch (error) {
      logger.error('Failed to initialize KnowledgeStore:', error);
      throw error;
    }
  }

  async addMessage(message: Message): Promise<void> {
    try {
      await this.storageProvider.addMessage(message);
    } catch (error) {
      logger.error('Failed to add message to storage:', error);
      throw error;
    }
  }

  async getMessages(): Promise<Message[]> {
    try {
      return await this.storageProvider.readMessages();
    } catch (error) {
      logger.error('Failed to get messages from storage:', error);
      return [];
    }
  }

  async clearMessages(): Promise<void> {
    try {
      await this.storageProvider.clearMessages();
    } catch (error) {
      logger.error('Failed to clear messages in storage:', error);
      throw error;
    }
  }

  getKnowledgeBase(): string {
    return this.knowledgeCache;
  }

  async updateKnowledgeBase(newKnowledge: string): Promise<void> {
    try {
      await this.storageProvider.writeKnowledge(newKnowledge);
      
      // Update cache
      this.knowledgeCache = newKnowledge;
      this.lastUpdatedCache = new Date().toISOString();
      
      logger.info(`Knowledge base updated: ${newKnowledge.length} characters`);
    } catch (error) {
      logger.error('Failed to update knowledge base in storage:', error);
      throw error;
    }
  }

  async getStats(): Promise<KnowledgeStats> {
    try {
      const messages = await this.getMessages();
      return {
        knowledgeLength: this.knowledgeCache.length,
        totalMessages: messages.length,
        lastUpdated: this.lastUpdatedCache
      };
    } catch (error) {
      logger.error('Failed to get stats:', error);
      return {
        knowledgeLength: this.knowledgeCache.length,
        totalMessages: 0,
        lastUpdated: this.lastUpdatedCache
      };
    }
  }

  // Synchronous version for backward compatibility
  getStatsSync(): KnowledgeStats {
    return {
      knowledgeLength: this.knowledgeCache.length,
      totalMessages: 0, // Will be inaccurate - should use async version
      lastUpdated: this.lastUpdatedCache
    };
  }
}