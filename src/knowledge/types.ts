export interface Message {
  id: string;
  text: string;
  user: string;
  channel: string;
  timestamp: string;
  thread_ts?: string;
}

export interface KnowledgeStats {
  knowledgeLength: number;
  totalMessages: number;
  lastUpdated: string | null;
}

export interface LearningSession {
  id: string;
  messagesProcessed: number;
  knowledgeLengthBefore: number;
  knowledgeLengthAfter: number;
  timestamp: string;
  success: boolean;
  error?: string;
}