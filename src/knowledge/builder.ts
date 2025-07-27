import { KnowledgeStore } from './vector-store';
import { LearningSession } from './types';
import { GeminiService } from '../services/gemini';
import { logger } from '../utils/logger';

export class BatchLearner {
  constructor(private knowledgeStore: KnowledgeStore, private geminiService: GeminiService) {}

  async processDaily(): Promise<LearningSession> {
    const currentKnowledge = this.knowledgeStore.getKnowledgeBase();
    
    const session: LearningSession = {
      id: `session_${Date.now()}`,
      messagesProcessed: 0,
      knowledgeLengthBefore: currentKnowledge.length,
      knowledgeLengthAfter: 0,
      timestamp: new Date().toISOString(),
      success: false
    };

    try {
      const messages = await this.knowledgeStore.getMessages();
      session.messagesProcessed = messages.length;

      if (messages.length === 0) {
        logger.info('No messages to process for daily learning');
        session.knowledgeLengthAfter = currentKnowledge.length;
        session.success = true;
        return session;
      }

      // Use Gemini to process messages and update knowledge base
      logger.info(`Processing ${messages.length} messages for learning with Gemini AI`);
      
      const learningResult = await this.geminiService.processKnowledgeUpdate(
        currentKnowledge, 
        messages.map(m => ({ text: m.text, user: m.user, timestamp: m.timestamp }))
      );
      
      // Update knowledge base and clear messages
      await this.knowledgeStore.updateKnowledgeBase(learningResult.updatedKnowledge);
      await this.knowledgeStore.clearMessages();
      
      session.knowledgeLengthAfter = learningResult.updatedKnowledge.length;
      session.success = true;
      
      logger.info('Daily learning session completed', {
        messagesProcessed: session.messagesProcessed,
        knowledgeGrowth: session.knowledgeLengthAfter - session.knowledgeLengthBefore,
        geminiSummary: learningResult.summary,
        changesCount: learningResult.changesCount
      });
      
      return session;
    } catch (error) {
      session.success = false;
      session.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Daily learning session failed', error);
      throw error;
    }
  }
}