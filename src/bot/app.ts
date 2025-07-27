import { App, ExpressReceiver } from '@slack/bolt';
import * as cron from 'node-cron';
import express from 'express';
import dotenv from 'dotenv';
import { KnowledgeStore } from '../knowledge/vector-store';
import { BatchLearner } from '../knowledge/builder';
import { MessageCollectionHandler } from './handlers/message';
import { QuestionResponseHandler } from './handlers/mention';
import { StartupMessageCollector } from '../services/startup-collector';
import { GeminiService } from '../services/gemini';
import { SupabaseStorage } from '../storage/supabase-storage';
import { logger } from '../utils/logger';

dotenv.config();

class CSKnowledgeBot {
  private app: App;
  private receiver: ExpressReceiver;
  private knowledgeStore: KnowledgeStore;
  private geminiService: GeminiService;
  private batchLearner: BatchLearner;
  private messageHandler: MessageCollectionHandler;
  private questionHandler: QuestionResponseHandler;
  private startupCollector: StartupMessageCollector;
  private port: number;
  private botUserId: string | null = null;

  constructor() {
    // Create ExpressReceiver to access router for analytics endpoints
    this.receiver = new ExpressReceiver({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      endpoints: '/'
    });

    // Use ExpressReceiver with Slack Bolt
    this.app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      receiver: this.receiver
    });
    
    logger.info('Using signing secret:', process.env.SLACK_SIGNING_SECRET?.substring(0, 8) + '...');

    // Initialize storage provider
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required');
    }

    const storageProvider = new SupabaseStorage(supabaseUrl, supabaseKey);
    this.knowledgeStore = new KnowledgeStore(storageProvider);
    this.geminiService = new GeminiService();
    this.batchLearner = new BatchLearner(this.knowledgeStore, this.geminiService);
    this.messageHandler = new MessageCollectionHandler(this.knowledgeStore, this.app.client);
    this.questionHandler = new QuestionResponseHandler(this.knowledgeStore, this.geminiService);
    this.startupCollector = new StartupMessageCollector(this.app, this.knowledgeStore, this.messageHandler);
    this.port = parseInt(process.env.PORT || '3000');

    this.setupEventHandlers();
    this.setupScheduledTasks();
    this.setupCustomEndpoints();
  }

  private setupEventHandlers(): void {
    // Message collection handler - Step 9 implementation
    this.app.message(async (args) => {
      await this.messageHandler.handleMessage(args);
    });

    // Mention handler - Step 10 implementation
    this.app.event('app_mention', async (args) => {
      const { event, say } = args;
      
      // Keep debug commands but handle them first
      if (event.text.includes('show messages')) {
        const messages = await this.knowledgeStore.getMessages();
        const stats = await this.knowledgeStore.getStats();
        
        logger.info('📋 Current collected messages:', {
          totalMessages: messages.length,
          messages: messages.map(msg => ({
            user: msg.user,
            channel: msg.channel,
            text: msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : ''),
            timestamp: msg.timestamp
          }))
        });
        
        await say(`I've collected ${stats.totalMessages} customer service messages so far. Check the logs for details!`);
        return;
      }
      
      if (event.text.includes('show knowledge')) {
        const knowledgeBase = this.knowledgeStore.getKnowledgeBase();
        const stats = await this.knowledgeStore.getStats();
        
        logger.info('🧠 Current knowledge base:', {
          knowledgeLength: stats.knowledgeLength,
          lastUpdated: stats.lastUpdated,
          preview: knowledgeBase.substring(0, 500) + (knowledgeBase.length > 500 ? '...' : ''),
          fullKnowledge: knowledgeBase
        });
        
        if (knowledgeBase.length === 0) {
          await say('My knowledge base is empty. No daily learning has been processed yet.');
        } else {
          await say(`My knowledge base contains ${stats.knowledgeLength} characters. Last updated: ${stats.lastUpdated}. Check the logs for the full content!`);
        }
        return;
      }
      
      if (event.text.includes('trigger learning')) {
        logger.info('🎓 Manual learning triggered');
        try {
          const session = await this.batchLearner.processDaily();
          await say(`Learning completed! Processed ${session.messagesProcessed} messages. Knowledge grew by ${session.knowledgeLengthAfter - session.knowledgeLengthBefore} characters.`);
        } catch (error) {
          logger.error('Manual learning failed', error);
          await say('Learning failed. Check the logs for details.');
        }
        return;
      }
      
      // Use the smart question handler for all other mentions
      await this.questionHandler.handleMention(args);
    });

    // Add a catch-all event handler for debugging
    this.app.event(/.*/, async ({ event }) => {
      logger.info('Any event received', { 
        type: event.type,
        event: event
      });
    });

    // Error handling
    this.app.error(async (error) => {
      logger.error('🚨 Slack app error:', error);
    });

    // Add middleware to log all incoming events
    this.app.use(async ({ body, next }) => {
      logger.info('🔄 Slack Bolt middleware triggered:', {
        type: (body as any).type,
        event: (body as any).event?.type || 'no event'
      });
      await next();
    });


    logger.info('Event handlers configured');
  }

  private setupScheduledTasks(): void {
    // Daily learning at 2 AM
    cron.schedule('0 2 * * *', async () => {
      logger.info('Starting daily learning process');
      try {
        await this.batchLearner.processDaily();
        logger.info('Daily learning completed successfully');
      } catch (error) {
        logger.error('Daily learning failed', error);
      }
    });

    logger.info('Scheduled daily learning at 2 AM');
  }

  private setupCustomEndpoints(): void {
    // Set up analytics and management endpoints
    this.setupAnalyticsEndpoints();
    logger.info('Analytics and management endpoints configured');
  }

  private setupAnalyticsEndpoints(): void {
    // Health check endpoint
    this.receiver.router.get('/health', async (req: any, res: any) => {
      const stats = await this.knowledgeStore.getStats();
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        bot: {
          userId: this.botUserId,
          messagesCollected: stats.totalMessages,
          knowledgeLength: stats.knowledgeLength,
          lastUpdated: stats.lastUpdated
        }
      };
      
      logger.info('Health check requested');
      res.json(health);
    });

    // Analytics endpoint with stats and knowledge preview
    this.receiver.router.get('/analytics', async (req: any, res: any) => {
      try {
        const stats = await this.knowledgeStore.getStats();
        const knowledgeBase = this.knowledgeStore.getKnowledgeBase();
        const messages = await this.knowledgeStore.getMessages();
        
        // Get knowledge quality analysis from Gemini
        let qualityAnalysis = null;
        try {
          qualityAnalysis = await this.geminiService.analyzeKnowledgeQuality(knowledgeBase);
        } catch (error) {
          logger.warn('Could not analyze knowledge quality:', error);
        }

        const analytics = {
          timestamp: new Date().toISOString(),
          collection: {
            totalMessages: stats.totalMessages,
            messagesAwaitingLearning: messages.length,
            lastCollected: messages.length > 0 ? messages[messages.length - 1].timestamp : null
          },
          knowledge: {
            length: stats.knowledgeLength,
            lastUpdated: stats.lastUpdated,
            preview: knowledgeBase.substring(0, 500) + (knowledgeBase.length > 500 ? '...' : ''),
            quality: qualityAnalysis
          },
          system: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            nodeVersion: process.version
          }
        };

        logger.info('Analytics requested');
        res.json(analytics);
      } catch (error) {
        logger.error('Error generating analytics:', error);
        res.status(500).json({ error: 'Failed to generate analytics' });
      }
    });

    // Manual knowledge update endpoint
    this.receiver.router.post('/update-knowledge', async (req: any, res: any) => {
      try {
        logger.info('Manual knowledge update triggered');
        const session = await this.batchLearner.processDaily();
        
        res.json({
          success: true,
          timestamp: new Date().toISOString(),
          session: {
            messagesProcessed: session.messagesProcessed,
            knowledgeGrowth: session.knowledgeLengthAfter - session.knowledgeLengthBefore,
            success: session.success
          }
        });
        
        logger.info('Manual knowledge update completed');
      } catch (error) {
        logger.error('Manual knowledge update failed:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Knowledge update failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Knowledge quality analysis endpoint
    this.receiver.router.get('/knowledge-quality', async (req: any, res: any) => {
      try {
        const knowledgeBase = this.knowledgeStore.getKnowledgeBase();
        const analysis = await this.geminiService.analyzeKnowledgeQuality(knowledgeBase);
        
        res.json({
          timestamp: new Date().toISOString(),
          knowledgeLength: knowledgeBase.length,
          analysis: analysis
        });
        
        logger.info('Knowledge quality analysis requested');
      } catch (error) {
        logger.error('Knowledge quality analysis failed:', error);
        res.status(500).json({ 
          error: 'Quality analysis failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Reset knowledge endpoint (for testing)
    this.receiver.router.post('/reset-knowledge', (req: any, res: any) => {
      try {
        this.knowledgeStore.updateKnowledgeBase('');
        this.knowledgeStore.clearMessages();
        
        res.json({
          success: true,
          message: 'Knowledge base has been reset',
          timestamp: new Date().toISOString()
        });
        
        logger.info('Knowledge base reset via API');
      } catch (error) {
        logger.error('Knowledge reset failed:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Reset failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Export knowledge endpoint
    this.receiver.router.get('/export-knowledge', async (req: any, res: any) => {
      try {
        const stats = await this.knowledgeStore.getStats();
        const knowledgeBase = this.knowledgeStore.getKnowledgeBase();
        const messages = await this.knowledgeStore.getMessages();
        
        const exportData = {
          exportedAt: new Date().toISOString(),
          stats: stats,
          knowledgeBase: knowledgeBase,
          pendingMessages: messages.map(m => ({
            text: m.text,
            user: m.user,
            channel: m.channel,
            timestamp: m.timestamp,
            thread_ts: m.thread_ts
          }))
        };

        // Set headers for file download
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="knowledge-export-${Date.now()}.json"`);
        res.json(exportData);
        
        logger.info('Knowledge export requested');
      } catch (error) {
        logger.error('Knowledge export failed:', error);
        res.status(500).json({ 
          error: 'Export failed',
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  public getCollectionStats(): void {
    const stats = this.knowledgeStore.getStats();
    logger.info('📊 Current collection stats:', stats);
  }

  private async initializeBotInfo(): Promise<void> {
    try {
      // Get bot user info
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || null;
      
      if (this.botUserId) {
        logger.info(`Bot user ID: ${this.botUserId}`);
        // Store in environment for startup collector
        process.env.SLACK_BOT_USER_ID = this.botUserId;
      } else {
        logger.warn('Could not determine bot user ID');
      }
    } catch (error) {
      logger.error('Error getting bot info:', error);
    }
  }

  private async collectHistoricalMessages(): Promise<void> {
    try {
      logger.info('Starting historical message collection...');
      await this.startupCollector.collectStartupMessages(30); // Last 30 days
      
      // If we collected messages and have no knowledge base, trigger initial learning
      const stats = await this.knowledgeStore.getStats();
      if (stats.totalMessages > 0 && stats.knowledgeLength === 0) {
        logger.info('Triggering initial learning with historical messages...');
        await this.batchLearner.processDaily();
        
        const newStats = await this.knowledgeStore.getStats();
        logger.info(`Initial knowledge base created: ${newStats.knowledgeLength} characters`);
      }
    } catch (error) {
      logger.error('Error during historical message collection:', error);
    }
  }

  public async start(): Promise<void> {
    try {
      // Initialize storage first
      logger.info('Initializing persistent storage...');
      await this.knowledgeStore.initialize();
      
      await this.app.start(this.port);
      logger.info(`CS Knowledge Bot is running on port ${this.port}`);
      logger.info('Bot is ready to collect messages and answer questions!');
      logger.info('Slack events endpoint: /');
      
      // Initialize bot info and collect historical messages
      await this.initializeBotInfo();
      await this.collectHistoricalMessages();
      
      logger.info('Bot startup complete with historical knowledge!');
    } catch (error) {
      logger.error('Failed to start bot', error);
      process.exit(1);
    }
  }

  public async stop(): Promise<void> {
    try {
      await this.app.stop();
      logger.info('Bot stopped successfully');
    } catch (error) {
      logger.error('Error stopping bot', error);
    }
  }
}

// Initialize and start the bot
const bot = new CSKnowledgeBot();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await bot.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await bot.stop();
  process.exit(0);
});

// Start the bot
bot.start().catch((error) => {
  logger.error('Failed to start application', error);
  process.exit(1);
});

export { CSKnowledgeBot };