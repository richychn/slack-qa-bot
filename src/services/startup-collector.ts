import { App } from '@slack/bolt';
import { KnowledgeStore } from '../knowledge/vector-store';
import { MessageCollectionHandler } from '../bot/handlers/message';
import { Message } from '../knowledge/types';
import { logger } from '../utils/logger';

export class StartupMessageCollector {
  private app: App;
  private knowledgeStore: KnowledgeStore;
  private messageHandler: MessageCollectionHandler;

  constructor(app: App, knowledgeStore: KnowledgeStore, messageHandler: MessageCollectionHandler) {
    this.app = app;
    this.knowledgeStore = knowledgeStore;
    this.messageHandler = messageHandler;
  }

  // Get all channels where the bot is a member
  private async getBotChannels(): Promise<string[]> {
    try {
      logger.info('Discovering channels where bot is present...');
      
      // Get list of all channels (try public first, then private if we have permission)
      let channelsResult;
      try {
        channelsResult = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 1000
        });
      } catch (error) {
        // Fallback to just public channels if we don't have private channel permissions
        logger.warn('Cannot access private channels, checking public channels only');
        channelsResult = await this.app.client.conversations.list({
          types: 'public_channel',
          exclude_archived: true,
          limit: 1000
        });
      }

      if (!channelsResult.channels) {
        logger.warn('No channels found');
        return [];
      }

      // Filter channels where bot is a member
      const botChannels: string[] = [];
      
      for (const channel of channelsResult.channels) {
        if (!channel.id) continue;
        
        try {
          // Check if bot is member of this channel
          const membersResult = await this.app.client.conversations.members({
            channel: channel.id
          });
          
          if (membersResult.members?.includes(process.env.SLACK_BOT_USER_ID || '')) {
            botChannels.push(channel.id);
            logger.info(`Found bot in channel: ${channel.name} (${channel.id})`);
          }
        } catch (error) {
          // Bot might not have access to this channel, skip it
          logger.debug(`Cannot access channel ${channel.name}: ${error}`);
        }
      }

      logger.info(`Bot is member of ${botChannels.length} channels`);
      return botChannels;
    } catch (error) {
      logger.error('Error discovering bot channels:', error);
      return [];
    }
  }

  // Fetch historical messages from a channel (full history)
  private async fetchChannelHistory(channelId: string, daysBack: number = 30): Promise<Message[]> {
    try {
      const messages: Message[] = [];
      const oldestTimestamp = Math.floor(Date.now() / 1000) - (daysBack * 24 * 60 * 60);
      
      logger.info(`Fetching ${daysBack} days of history from channel ${channelId}...`);
      
      let cursor: string | undefined;
      let pageCount = 0;
      const maxPages = 10; // Limit to prevent excessive API calls
      
      do {
        const result = await this.app.client.conversations.history({
          channel: channelId,
          oldest: oldestTimestamp.toString(),
          limit: 100,
          cursor: cursor
        });

        if (!result.messages) break;

        for (const slackMessage of result.messages) {
          // Skip bot messages and messages without text
          if (slackMessage.bot_id || slackMessage.subtype === 'bot_message' || !slackMessage.text) {
            continue;
          }

          // Convert to our Message format
          const message: Message = {
            id: `${slackMessage.ts}_${channelId}`,
            text: slackMessage.text,
            user: slackMessage.user || 'unknown',
            channel: channelId,
            timestamp: slackMessage.ts || '',
            thread_ts: slackMessage.thread_ts
          };

          messages.push(message);

          // If this message has thread replies, fetch them too
          if (slackMessage.reply_count && slackMessage.reply_count > 0) {
            const threadMessages = await this.fetchThreadReplies(channelId, slackMessage.ts!, oldestTimestamp);
            messages.push(...threadMessages);
          }
        }

        cursor = result.response_metadata?.next_cursor;
        pageCount++;
        
        // Add small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } while (cursor && pageCount < maxPages);

      logger.info(`Collected ${messages.length} messages from channel ${channelId}`);
      return messages;
      
    } catch (error) {
      logger.error(`Error fetching history from channel ${channelId}:`, error);
      return [];
    }
  }

  // Fetch incremental messages from a channel since last collection
  private async fetchChannelHistorySince(channelId: string, sinceTimestamp: number): Promise<Message[]> {
    try {
      const messages: Message[] = [];
      
      logger.info(`Fetching messages since ${new Date(sinceTimestamp * 1000).toISOString()} from channel ${channelId}...`);
      
      let cursor: string | undefined;
      let pageCount = 0;
      const maxPages = 10; // Limit to prevent excessive API calls
      
      do {
        const result = await this.app.client.conversations.history({
          channel: channelId,
          oldest: sinceTimestamp.toString(),
          limit: 100,
          cursor: cursor
        });

        if (!result.messages) break;

        logger.debug(`API returned ${result.messages.length} messages from channel ${channelId} since ${sinceTimestamp}`);

        for (const slackMessage of result.messages) {
          // Skip bot messages and messages without text
          if (slackMessage.bot_id || slackMessage.subtype === 'bot_message' || !slackMessage.text) {
            continue;
          }

          const messageTimestamp = parseFloat(slackMessage.ts || '0');
          logger.debug(`Found message: ts=${messageTimestamp}, since=${sinceTimestamp}, newer=${messageTimestamp > sinceTimestamp}, text="${slackMessage.text?.substring(0, 50)}"`);

          // Convert to our Message format
          const message: Message = {
            id: `${slackMessage.ts}_${channelId}`,
            text: slackMessage.text,
            user: slackMessage.user || 'unknown',
            channel: channelId,
            timestamp: slackMessage.ts || '',
            thread_ts: slackMessage.thread_ts
          };

          messages.push(message);

          // If this message has thread replies, fetch them too
          if (slackMessage.reply_count && slackMessage.reply_count > 0) {
            const threadMessages = await this.fetchThreadReplies(channelId, slackMessage.ts!, sinceTimestamp);
            messages.push(...threadMessages);
          }
        }

        cursor = result.response_metadata?.next_cursor;
        pageCount++;
        
        // Add small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } while (cursor && pageCount < maxPages);

      logger.info(`Collected ${messages.length} new messages from channel ${channelId}`);
      return messages;
      
    } catch (error) {
      logger.error(`Error fetching incremental history from channel ${channelId}:`, error);
      return [];
    }
  }

  // Fetch thread replies for a specific message
  private async fetchThreadReplies(channelId: string, threadTs: string, oldestTimestamp: number): Promise<Message[]> {
    try {
      const threadMessages: Message[] = [];
      
      const repliesResult = await this.app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        oldest: oldestTimestamp.toString(),
        limit: 100
      });

      if (!repliesResult.messages || repliesResult.messages.length <= 1) {
        // No replies or only the parent message
        return threadMessages;
      }

      // Process each reply (skip the first message as it's the parent)
      for (let i = 1; i < repliesResult.messages.length; i++) {
        const reply = repliesResult.messages[i];
        
        // Skip bot messages and messages without text
        if ((reply as any).bot_id || (reply as any).subtype === 'bot_message' || !reply.text) {
          continue;
        }

        const replyMessage: Message = {
          id: `${(reply as any).ts}_${channelId}_reply`,
          text: reply.text,
          user: (reply as any).user || 'unknown',
          channel: channelId,
          timestamp: (reply as any).ts || '',
          thread_ts: threadTs
        };

        threadMessages.push(replyMessage);
      }

      logger.debug(`Collected ${threadMessages.length} thread replies for ${threadTs}`);
      
      // Add small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return threadMessages;
    } catch (error) {
      logger.error(`Error fetching thread replies for ${threadTs}:`, error);
      return [];
    }
  }

  // Filter messages (now accepts all non-empty messages)
  private async filterRelevantMessages(messages: Message[]): Promise<Message[]> {
    const relevantMessages: Message[] = [];
    
    for (const message of messages) {
      if (message.text && message.text.trim().length > 0) {
        relevantMessages.push(message);
      }
    }

    logger.info(`Filtered ${relevantMessages.length} relevant messages from ${messages.length} total messages`);
    return relevantMessages;
  }

  // Main method to collect startup messages (incremental)
  public async collectStartupMessages(daysBack: number = 30): Promise<void> {
    try {
      logger.info('Starting message collection...');
      const startTime = Date.now();

      // Get last collection timestamp from storage
      const lastCollectionTimestamp = await this.knowledgeStore.storage.getLastCollectionTimestamp();
      
      if (lastCollectionTimestamp) {
        logger.info(`Last collection: ${lastCollectionTimestamp}. Collecting incremental messages...`);
        await this.collectIncrementalMessages(lastCollectionTimestamp);
      } else {
        logger.info('First time collection. Collecting full historical messages...');
        await this.collectFullHistoricalMessages(daysBack);
      }

      // Update collection timestamp to now AFTER all channels are processed
      const now = new Date().toISOString();
      await this.knowledgeStore.storage.updateCollectionTimestamp(now);
      logger.info(`Marked collection complete at: ${now}`);

      const duration = (Date.now() - startTime) / 1000;
      logger.info(`Message collection completed in ${duration.toFixed(1)}s`);

    } catch (error) {
      logger.error('Error during message collection:', error);
    }
  }

  // Update collection timestamp after startup is complete
  public async markCollectionComplete(): Promise<void> {
    try {
      const now = new Date().toISOString();
      const nowUnix = Date.now() / 1000;
      
      logger.info(`Marking collection complete: ISO=${now}, Unix=${nowUnix}`);
      
      await this.knowledgeStore.storage.updateCollectionTimestamp(now);
      logger.info(`Marked collection complete at: ${now}`);
    } catch (error) {
      logger.error('Error marking collection complete:', error);
    }
  }

  // Collect incremental messages since last timestamp
  private async collectIncrementalMessages(lastTimestamp: string): Promise<void> {
    // Force UTC interpretation by adding Z suffix if missing
    const utcTimestamp = lastTimestamp.endsWith('Z') ? lastTimestamp : lastTimestamp + 'Z';
    
    // Convert ISO timestamp to Unix timestamp (Slack format)
    const sinceTimestamp = new Date(utcTimestamp).getTime() / 1000;
    
    logger.info(`Converting collection timestamp: ${lastTimestamp} → ${utcTimestamp} → ${sinceTimestamp}`);
    
    // Get channels where bot is present
    const channels = await this.getBotChannels();
    
    if (channels.length === 0) {
      logger.warn('No channels found where bot is present. Skipping incremental collection.');
      return;
    }

    // Collect new messages from all channels
    let allMessages: Message[] = [];
    
    for (const channelId of channels) {
      const channelMessages = await this.fetchChannelHistorySince(channelId, sinceTimestamp);
      allMessages = allMessages.concat(channelMessages);
    }

    logger.info(`Total new messages collected: ${allMessages.length}`);

    if (allMessages.length === 0) {
      logger.info('No new messages found since last collection.');
      return;
    }

    // Filter for relevant messages
    const relevantMessages = await this.filterRelevantMessages(allMessages);

    if (relevantMessages.length === 0) {
      logger.info('No new relevant messages found.');
      return;
    }

    // Add to knowledge store
    for (const message of relevantMessages) {
      await this.knowledgeStore.addMessage(message);
    }

    logger.info(`Added ${relevantMessages.length} new messages to collection`);
  }

  // Collect full historical messages (first time only)
  private async collectFullHistoricalMessages(daysBack: number): Promise<void> {
    // Get channels where bot is present
    const channels = await this.getBotChannels();
    
    if (channels.length === 0) {
      logger.warn('No channels found where bot is present. Skipping historical collection.');
      return;
    }

    // Collect messages from all channels
    let allMessages: Message[] = [];
    
    for (const channelId of channels) {
      const channelMessages = await this.fetchChannelHistory(channelId, daysBack);
      allMessages = allMessages.concat(channelMessages);
    }

    logger.info(`Total historical messages collected: ${allMessages.length}`);

    // Filter for relevant messages
    const relevantMessages = await this.filterRelevantMessages(allMessages);

    if (relevantMessages.length === 0) {
      logger.info('No historical relevant messages found.');
      return;
    }

    // Add to knowledge store
    for (const message of relevantMessages) {
      await this.knowledgeStore.addMessage(message);
    }

    logger.info(`Added ${relevantMessages.length} historical messages to collection`);

    // Trigger immediate learning for first time setup
    const currentKnowledge = this.knowledgeStore.getKnowledgeBase();
    if (currentKnowledge.length === 0 && relevantMessages.length > 0) {
      logger.info('No existing knowledge base found. Initial learning will be triggered after startup...');
    }
  }
}