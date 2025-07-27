import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { StorageProvider } from './storage-interface';
import { Message } from '../knowledge/types';
import { logger } from '../utils/logger';

export class SupabaseStorage implements StorageProvider {
  private supabase: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async initialize(): Promise<void> {
    try {
      // Create tables if they don't exist
      await this.createTables();
      logger.info('Supabase storage initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Supabase storage:', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    // Create knowledge_base table
    const { error: knowledgeError } = await this.supabase.rpc('create_knowledge_table', {});
    if (knowledgeError && !knowledgeError.message.includes('already exists')) {
      // Try creating with raw SQL if RPC doesn't exist
      const { error } = await this.supabase
        .from('knowledge_base')
        .select('id')
        .limit(1);
      
      if (error && error.message.includes('does not exist')) {
        logger.info('Creating knowledge_base table...');
        // Table doesn't exist - this is expected on first run
        // Supabase will auto-create tables when we first insert
      }
    }

    // Create collected_messages table
    const { error: messagesError } = await this.supabase.rpc('create_messages_table', {});
    if (messagesError && !messagesError.message.includes('already exists')) {
      const { error } = await this.supabase
        .from('collected_messages')
        .select('id')
        .limit(1);
      
      if (error && error.message.includes('does not exist')) {
        logger.info('Creating collected_messages table...');
        // Table doesn't exist - will be auto-created on first insert
      }
    }
  }

  async readKnowledge(): Promise<string | null> {
    try {
      const { data, error } = await this.supabase
        .from('knowledge_base')
        .select('content')
        .eq('id', 1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows found
          return null;
        }
        throw error;
      }

      return data?.content || null;
    } catch (error) {
      logger.error('Error reading knowledge from Supabase:', error);
      return null;
    }
  }

  async writeKnowledge(content: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('knowledge_base')
        .upsert({
          id: 1,
          content: content,
          updated_at: new Date().toISOString(),
          version: 1 // TODO: Implement proper versioning
        });

      if (error) throw error;
      
      logger.info('Knowledge base updated in Supabase');
    } catch (error) {
      logger.error('Error writing knowledge to Supabase:', error);
      throw error;
    }
  }

  async getKnowledgeMetadata(): Promise<{ lastUpdated: string | null; version: number; lastCollectionTimestamp: string | null }> {
    try {
      const { data, error } = await this.supabase
        .from('knowledge_base')
        .select('updated_at, version, last_collection_timestamp')
        .eq('id', 1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows found
          return { lastUpdated: null, version: 0, lastCollectionTimestamp: null };
        }
        throw error;
      }

      return {
        lastUpdated: data?.updated_at || null,
        version: data?.version || 1,
        lastCollectionTimestamp: data?.last_collection_timestamp || null
      };
    } catch (error) {
      logger.error('Error reading knowledge metadata from Supabase:', error);
      return { lastUpdated: null, version: 0, lastCollectionTimestamp: null };
    }
  }

  async readMessages(): Promise<Message[]> {
    try {
      const { data, error } = await this.supabase
        .from('collected_messages')
        .select('*')
        .eq('processed', false)
        .order('timestamp', { ascending: true });

      if (error) throw error;

      return (data || []).map(row => ({
        id: row.message_id,
        text: row.text,
        user: row.user_id,
        channel: row.channel_id,
        timestamp: row.timestamp,
        thread_ts: row.thread_ts
      }));
    } catch (error) {
      logger.error('Error reading messages from Supabase:', error);
      return [];
    }
  }

  async writeMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    try {
      const rows = messages.map(msg => ({
        message_id: msg.id,
        text: msg.text,
        user_id: msg.user,
        channel_id: msg.channel,
        timestamp: msg.timestamp,
        thread_ts: msg.thread_ts,
        processed: false,
        created_at: new Date().toISOString()
      }));

      const { error } = await this.supabase
        .from('collected_messages')
        .upsert(rows, { onConflict: 'message_id' });

      if (error) throw error;
      
      logger.info(`Saved ${messages.length} messages to Supabase`);
    } catch (error) {
      logger.error('Error writing messages to Supabase:', error);
      throw error;
    }
  }

  async addMessage(message: Message): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('collected_messages')
        .upsert({
          message_id: message.id,
          text: message.text,
          user_id: message.user,
          channel_id: message.channel,
          timestamp: message.timestamp,
          thread_ts: message.thread_ts,
          processed: false,
          created_at: new Date().toISOString()
        }, { onConflict: 'message_id' });

      if (error) throw error;
    } catch (error) {
      logger.error('Error adding message to Supabase:', error);
      throw error;
    }
  }

  async clearMessages(): Promise<void> {
    try {
      // Mark messages as processed instead of deleting
      const { error } = await this.supabase
        .from('collected_messages')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('processed', false);

      if (error) throw error;
      
      logger.info('Marked all pending messages as processed in Supabase');
    } catch (error) {
      logger.error('Error clearing messages in Supabase:', error);
      throw error;
    }
  }

  async updateCollectionTimestamp(timestamp: string): Promise<void> {
    try {
      const timestampUnix = new Date(timestamp).getTime() / 1000;
      const currentUnix = Date.now() / 1000;
      
      logger.info(`Storing timestamp: ISO=${timestamp}, Unix=${timestampUnix}, Current=${currentUnix}, Future=${timestampUnix > currentUnix}`);
      
      // Safety check - don't store future timestamps
      if (timestampUnix > currentUnix + 60) { // Allow 1 minute tolerance
        logger.error(`Refusing to store future timestamp! Provided: ${timestamp} (${timestampUnix}), Current: ${currentUnix}`);
        return;
      }
      
      const { error } = await this.supabase
        .from('knowledge_base')
        .upsert({
          id: 1,
          last_collection_timestamp: timestamp
        }, { onConflict: 'id' });

      if (error) throw error;
      
      logger.info(`Updated collection timestamp: ${timestamp}`);
    } catch (error) {
      logger.error('Error updating collection timestamp in Supabase:', error);
      throw error;
    }
  }

  async getLastCollectionTimestamp(): Promise<string | null> {
    try {
      const { data, error } = await this.supabase
        .from('knowledge_base')
        .select('last_collection_timestamp')
        .eq('id', 1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows found
          return null;
        }
        throw error;
      }

      const retrieved = data?.last_collection_timestamp || null;
      
      if (retrieved) {
        const retrievedUnix = new Date(retrieved).getTime() / 1000;
        const currentUnix = Date.now() / 1000;
        logger.info(`Retrieved timestamp from DB: Raw="${retrieved}", Unix=${retrievedUnix}, Current=${currentUnix}, Future=${retrievedUnix > currentUnix}`);
      }

      return retrieved;
    } catch (error) {
      logger.error('Error reading collection timestamp from Supabase:', error);
      return null;
    }
  }
}