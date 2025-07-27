import { SlackEventMiddlewareArgs } from '@slack/bolt';
import { KnowledgeStore } from '../../knowledge/vector-store';
import { Message } from '../../knowledge/types';
import { logger } from '../../utils/logger';

export class MessageCollectionHandler {
  private knowledgeStore: KnowledgeStore;
  private appClient: any;

  constructor(knowledgeStore: KnowledgeStore, appClient?: any) {
    this.knowledgeStore = knowledgeStore;
    this.appClient = appClient;
  }

  // Check if message is relevant (now accepts all non-empty messages)
  private isRelevantMessage(text: string): boolean {
    return !!(text && text.trim().length > 0);
  }

  // Check if message is from a bot
  private isBotMessage(message: any): boolean {
    return message.bot_id !== undefined || 
           message.subtype === 'bot_message' ||
           message.user === undefined;
  }

  // Process incoming message
  public async handleMessage(args: SlackEventMiddlewareArgs<'message'>): Promise<void> {
    const { message } = args;
    
    try {
      // Skip bot messages
      if (this.isBotMessage(message)) {
        logger.debug('Skipping bot message');
        return;
      }

      const messageText = (message as any).text;
      const messageUser = (message as any).user;

      // Check if this is a relevant message (all non-empty messages)
      if (this.isRelevantMessage(messageText)) {
        const csMessage: Message = {
          id: `${message.ts}_${message.channel}`,
          text: messageText,
          user: messageUser,
          channel: message.channel!,
          timestamp: message.ts!,
          thread_ts: (message as any).thread_ts
        };

        // Add to knowledge store for daily learning
        await this.knowledgeStore.addMessage(csMessage);

        logger.info('Message collected:', {
          user: messageUser,
          channel: message.channel,
          preview: messageText.substring(0, 50) + (messageText.length > 50 ? '...' : ''),
          isThreaded: !!(message as any).thread_ts
        });

        // If this is a threaded message or starts a thread, collect thread replies
        if (this.appClient) {
          await this.collectThreadReplies(this.appClient, message.channel!, message.ts!, (message as any).thread_ts);
        }
      } else {
        logger.debug('Message is empty or invalid, skipping');
      }

    } catch (error) {
      logger.error('Error processing message for collection:', error);
    }
  }

  // Collect all replies in a thread if the main message is customer service related
  private async collectThreadReplies(client: any, channelId: string, messageTs: string, threadTs?: string): Promise<void> {
    try {
      // Use thread_ts if available, otherwise use the message timestamp (for parent messages)
      const threadTimestamp = threadTs || messageTs;
      
      // Fetch all replies in the thread
      const repliesResult = await client.conversations.replies({
        channel: channelId,
        ts: threadTimestamp,
        limit: 100
      });

      if (!repliesResult.messages || repliesResult.messages.length <= 1) {
        // No replies or only the parent message
        return;
      }

      // Process each reply (skip the first message as it's the parent)
      for (let i = 1; i < repliesResult.messages.length; i++) {
        const reply = repliesResult.messages[i];
        
        // Skip bot messages
        if (this.isBotMessage(reply)) {
          continue;
        }

        // Check if reply is relevant (all non-empty messages)
        if (this.isRelevantMessage(reply.text || '')) {
          const replyMessage: Message = {
            id: `${reply.ts}_${channelId}_reply`,
            text: reply.text || '',
            user: reply.user || 'unknown',
            channel: channelId,
            timestamp: reply.ts || '',
            thread_ts: threadTimestamp
          };

          await this.knowledgeStore.addMessage(replyMessage);

          logger.info('Thread reply collected:', {
            user: reply.user,
            channel: channelId,
            threadTs: threadTimestamp,
            preview: (reply.text || '').substring(0, 50) + ((reply.text || '').length > 50 ? '...' : '')
          });
        }
      }
    } catch (error) {
      logger.error('Error collecting thread replies:', error);
    }
  }
}