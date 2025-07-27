import { SlackEventMiddlewareArgs } from '@slack/bolt';
import { KnowledgeStore } from '../../knowledge/vector-store';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';

interface AIResponse {
  answer: string;
  confidence: number;
  reasoning: string;
}

export class QuestionResponseHandler {
  private knowledgeStore: KnowledgeStore;
  private geminiService: GeminiService;
  private confidenceThreshold: number;

  constructor(knowledgeStore: KnowledgeStore, geminiService: GeminiService) {
    this.knowledgeStore = knowledgeStore;
    this.geminiService = geminiService;
    this.confidenceThreshold = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.8');
  }

  // Check if the mention contains a question
  private isQuestion(text: string): boolean {
    const questionWords = ['how', 'what', 'why', 'when', 'where', 'who', 'which', 'can', 'could', 'should', 'would', 'is', 'are', 'do', 'does', 'did'];
    const questionMarks = text.includes('?');
    const hasQuestionWord = questionWords.some(word => 
      text.toLowerCase().includes(word.toLowerCase())
    );
    
    return questionMarks || hasQuestionWord;
  }

  // Extract the actual question from the mention text
  private extractQuestion(text: string): string {
    // Remove the bot mention (e.g., "<@U123456789>")
    const question = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    return question;
  }

  // Generate AI response using Gemini
  private async generateAIResponse(question: string, knowledgeBase: string): Promise<AIResponse> {
    return await this.geminiService.answerQuestion(question, knowledgeBase);
  }

  // Main handler for app_mention events
  public async handleMention(args: SlackEventMiddlewareArgs<'app_mention'>): Promise<void> {
    const { event, say } = args;
    
    try {
      const questionText = this.extractQuestion(event.text);
      
      // Check if this is actually a question
      if (!this.isQuestion(questionText)) {
        logger.info('Mention received but not detected as a question:', { text: questionText });
        await say("Hi! I'm here to help with customer service questions. Ask me something like 'How do I fix login issues?' and I'll try to help based on our support knowledge.");
        return;
      }

      logger.info('Question received:', {
        user: event.user,
        channel: event.channel,
        question: questionText
      });

      // Get current knowledge base
      const knowledgeBase = this.knowledgeStore.getKnowledgeBase();
      const stats = await this.knowledgeStore.getStats();

      logger.info('Processing question with knowledge base:', {
        questionLength: questionText.length,
        knowledgeLength: stats.knowledgeLength,
        lastUpdated: stats.lastUpdated
      });

      // Generate AI response
      const aiResponse = await this.generateAIResponse(questionText, knowledgeBase);

      logger.info('AI response generated:', {
        confidence: aiResponse.confidence,
        confidenceThreshold: this.confidenceThreshold,
        reasoning: aiResponse.reasoning,
        answerLength: aiResponse.answer.length
      });

      // Check confidence threshold
      if (aiResponse.confidence >= this.confidenceThreshold) {
        // High confidence - provide the answer
        await say(`${aiResponse.answer}\n\n_Confidence: ${Math.round(aiResponse.confidence * 100)}% (${aiResponse.reasoning})_`);
        
        logger.info('High confidence response provided:', {
          confidence: aiResponse.confidence,
          user: event.user
        });
      } else {
        // Low confidence - politely decline
        await say(`I'm not confident enough to answer that question (${Math.round(aiResponse.confidence * 100)}% confidence, need ${Math.round(this.confidenceThreshold * 100)}%+). I specialize in customer service topics based on our support history. Try asking about issues that have been reported before, or help me learn by collecting more support messages.`);
        
        logger.info('Low confidence - declined to answer:', {
          confidence: aiResponse.confidence,
          threshold: this.confidenceThreshold,
          reasoning: aiResponse.reasoning,
          user: event.user
        });
      }

    } catch (error) {
      logger.error('Error processing question:', error);
      await say('Sorry, I encountered an error while processing your question. Please try again.');
    }
  }
}