import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { logger } from '../utils/logger';

interface AIResponse {
  answer: string;
  confidence: number;
  reasoning: string;
}

interface LearningResult {
  updatedKnowledge: string;
  summary: string;
  changesCount: number;
}

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 2048,
      },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ],
    });

    logger.info('Gemini AI service initialized');
  }

  // Answer user questions based on knowledge base
  async answerQuestion(question: string, knowledgeBase: string): Promise<AIResponse> {
    try {
      if (!knowledgeBase || knowledgeBase.trim().length === 0) {
        return {
          answer: "I don't have enough knowledge yet to answer questions. Please collect some customer service messages first.",
          confidence: 0.1,
          reasoning: "No knowledge base available"
        };
      }

      const prompt = `You are a customer service AI assistant. Based on the knowledge base below, answer the user's question.

KNOWLEDGE BASE:
${knowledgeBase}

USER QUESTION: ${question}

Please provide:
1. A helpful answer based only on the knowledge base
2. A confidence score (0.0 to 1.0) based on how well the knowledge base covers this topic
3. Brief reasoning for your confidence level

Format your response as JSON:
{
  "answer": "your detailed answer here",
  "confidence": 0.85,
  "reasoning": "explanation of confidence level"
}

Important guidelines:
- Only use information from the knowledge base provided
- If the knowledge base doesn't contain relevant information, say so and give low confidence
- Higher confidence (0.8+) for topics well-covered in knowledge base
- Lower confidence (0.5-) for topics with limited or unclear information
- Be honest about limitations`;

      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid JSON response from Gemini');
      }

      const aiResponse = JSON.parse(jsonMatch[0]);

      // Validate response structure
      if (!aiResponse.answer || typeof aiResponse.confidence !== 'number') {
        throw new Error('Invalid response structure from Gemini');
      }

      // Ensure confidence is between 0 and 1
      aiResponse.confidence = Math.max(0, Math.min(1, aiResponse.confidence));

      logger.info('Gemini question answered:', {
        questionLength: question.length,
        answerLength: aiResponse.answer.length,
        confidence: aiResponse.confidence,
        reasoning: aiResponse.reasoning
      });

      return aiResponse;

    } catch (error) {
      logger.error('Error processing question with Gemini:', error);
      
      // Fallback response
      return {
        answer: "I'm having trouble processing your question right now. Please try again later.",
        confidence: 0.1,
        reasoning: "Technical error occurred"
      };
    }
  }

  // Process daily messages and update knowledge base
  async processKnowledgeUpdate(currentKnowledge: string, newMessages: Array<{text: string, user: string, timestamp: string}>): Promise<LearningResult> {
    try {
      if (newMessages.length === 0) {
        return {
          updatedKnowledge: currentKnowledge,
          summary: "No new messages to process",
          changesCount: 0
        };
      }

      const messagesText = newMessages.map(m => `[${m.user}]: ${m.text}`).join('\n');

      const prompt = `You are a knowledge management AI. Your job is to update a customer service knowledge base with new information from support conversations.

CURRENT KNOWLEDGE BASE:
${currentKnowledge || 'Empty - this will be the first knowledge entry'}

NEW CUSTOMER SERVICE MESSAGES:
${messagesText}

Please analyze the new messages and update the knowledge base by:
1. Adding new facts, solutions, or procedures mentioned
2. Updating existing information if it's more current or accurate
3. Organizing information clearly by topic/issue type
4. Removing outdated or incorrect information
5. Maintaining a professional, helpful tone

Format your response as JSON:
{
  "updatedKnowledge": "the complete updated knowledge base text",
  "summary": "brief summary of what was learned/updated",
  "changesCount": number_of_significant_changes_made
}

Guidelines:
- Focus on actionable information: solutions, procedures, known issues
- Ignore casual conversation and focus on customer service content
- Organize by topics like "Login Issues", "Bug Reports", "Feature Requests", etc.
- Keep the knowledge base concise but comprehensive
- If no useful information is found, return the original knowledge base unchanged`;

      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid JSON response from Gemini');
      }

      const learningResult = JSON.parse(jsonMatch[0]);

      // Validate response structure
      if (!learningResult.updatedKnowledge || !learningResult.summary) {
        throw new Error('Invalid learning result structure from Gemini');
      }

      logger.info('Gemini knowledge update completed:', {
        messagesProcessed: newMessages.length,
        changesCount: learningResult.changesCount,
        knowledgeGrowth: learningResult.updatedKnowledge.length - currentKnowledge.length,
        summary: learningResult.summary
      });

      return learningResult;

    } catch (error) {
      logger.error('Error updating knowledge base with Gemini:', error);
      
      // Fallback to simple append if Gemini fails
      const messageTexts = newMessages.map(m => `[${m.user}]: ${m.text}`).join('\n');
      const fallbackKnowledge = currentKnowledge === '' 
        ? `Customer Service Knowledge Base\n\nRecent Issues:\n${messageTexts}`
        : `${currentKnowledge}\n\nNew Issues (${new Date().toDateString()}):\n${messageTexts}`;

      return {
        updatedKnowledge: fallbackKnowledge,
        summary: "Fallback update due to AI processing error",
        changesCount: newMessages.length
      };
    }
  }

  // Analyze knowledge base quality and completeness
  async analyzeKnowledgeQuality(knowledgeBase: string): Promise<{score: number, suggestions: string[], coverage: string[]}> {
    try {
      if (!knowledgeBase || knowledgeBase.trim().length === 0) {
        return {
          score: 0,
          suggestions: ["Knowledge base is empty - start collecting customer service messages"],
          coverage: []
        };
      }

      const prompt = `Analyze this customer service knowledge base and provide quality assessment:

KNOWLEDGE BASE:
${knowledgeBase}

Please evaluate and provide:
1. Quality score (0-100) based on completeness, organization, and usefulness
2. Specific suggestions for improvement
3. List of topics/areas currently covered

Format as JSON:
{
  "score": 85,
  "suggestions": ["add more specific error codes", "organize by product area"],
  "coverage": ["login issues", "password reset", "billing questions"]
}`;

      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid JSON response from Gemini');
      }

      return JSON.parse(jsonMatch[0]);

    } catch (error) {
      logger.error('Error analyzing knowledge quality:', error);
      return {
        score: 50,
        suggestions: ["Unable to analyze due to technical error"],
        coverage: ["Analysis unavailable"]
      };
    }
  }
}