/**
 * Gemini Client for AsyncThink
 *
 * Direct Gemini API calls for fast metacognitive feedback and web research.
 * Used alongside Claude Code workers for hybrid async operations.
 *
 * Features:
 * - Gemini 3 Pro for reasoning/feedback
 * - Grounded search (Google Search) for web research
 * - Fast execution (2-5 seconds vs 45-90s for Claude Code)
 */

import { getConfigManager } from './config.js';

// Default model for Gemini workers (can be changed via config)
const DEFAULT_MODEL = 'gemini-3-pro-preview';

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export interface GenerateContentParams {
  prompt: string;
  enableGroundedSearch?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  systemInstruction?: string;
}

export interface GenerateResult {
  text: string;
  usage?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  groundingMetadata?: {
    webSearchQueries?: string[];
    groundingChunks?: Array<{
      web?: { uri: string; title: string };
    }>;
  };
}

export class GeminiClient {
  private ai: any = null;
  private GoogleGenAIClass: any = null;
  private initialized = false;
  private config: GeminiConfig | null = null;

  /**
   * Get configuration from environment
   */
  private getConfig(): GeminiConfig {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        'Gemini API key not found.\n' +
        'Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.\n' +
        'Get your API key from: https://aistudio.google.com/app/apikey'
      );
    }

    const configManager = getConfigManager();
    const model = configManager.getValue('geminiModel') || DEFAULT_MODEL;

    return { apiKey, model };
  }

  /**
   * Lazy-initialize the GoogleGenAI client
   */
  private async getClient(): Promise<any> {
    if (this.ai) {
      return this.ai;
    }

    // Get configuration
    this.config = this.getConfig();

    // Lazy-load the @google/genai SDK
    if (!this.GoogleGenAIClass) {
      const module = await import('@google/genai');
      this.GoogleGenAIClass = module.GoogleGenAI;
    }

    try {
      console.error('[GeminiClient] Initializing with API key...');

      this.ai = new this.GoogleGenAIClass({
        apiKey: this.config.apiKey,
      });

      this.initialized = true;
      console.error(`[GeminiClient] Initialization successful (model: ${this.config.model})`);
    } catch (error: any) {
      console.error('[GeminiClient] Initialization failed:', error.message);
      throw error;
    }

    return this.ai;
  }

  /**
   * Generate content using Gemini
   * Supports grounded search (Google Search) for web research
   */
  async generateContent(params: GenerateContentParams): Promise<GenerateResult> {
    const client = await this.getClient();

    const {
      prompt,
      enableGroundedSearch = false,
      maxTokens = 4000,
      temperature = 0.7,
      model = this.config?.model || DEFAULT_MODEL,
      systemInstruction,
    } = params;

    // Build generation config - tools go INSIDE config per @google/genai SDK
    const config: any = {
      temperature,
      maxOutputTokens: maxTokens,
    };

    // Enable grounded search (Google Search tool) if requested
    // Per SDK docs: tools must be nested inside config, not at request root
    if (enableGroundedSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    // Build contents
    const contents = [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ];

    // Build request options
    const requestOptions: any = {
      model,
      contents,
      config,
    };

    if (systemInstruction) {
      requestOptions.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    console.error(`[GeminiClient] Generating content with model: ${model}`);
    console.error(`[GeminiClient] Grounded search: ${enableGroundedSearch}`);

    try {
      const startTime = Date.now();
      const result = await client.models.generateContent(requestOptions);
      const elapsed = Date.now() - startTime;

      // Extract response text
      const responseText = result.text || '';

      // Extract token usage
      const usage = result.usageMetadata
        ? {
            promptTokenCount: result.usageMetadata.promptTokenCount || 0,
            candidatesTokenCount: result.usageMetadata.candidatesTokenCount || 0,
            totalTokenCount: result.usageMetadata.totalTokenCount || 0,
          }
        : undefined;

      // Extract grounding metadata if present
      const groundingMetadata = result.candidates?.[0]?.groundingMetadata;

      console.error(`[GeminiClient] Response: ${responseText.length} chars in ${elapsed}ms`);
      if (usage) {
        console.error(`[GeminiClient] Tokens: ${usage.totalTokenCount}`);
      }
      if (groundingMetadata?.webSearchQueries?.length) {
        console.error(
          `[GeminiClient] Grounded searches: ${groundingMetadata.webSearchQueries.length}`
        );
      }

      return {
        text: responseText,
        usage,
        groundingMetadata,
      };
    } catch (error: any) {
      console.error(`[GeminiClient] Error generating content:`, error.message);
      throw error;
    }
  }

  /**
   * Check if client is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if Gemini is available (API key is set)
   */
  static isAvailable(): boolean {
    return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  }
}

// Singleton instance
let clientInstance: GeminiClient | null = null;

/**
 * Get the singleton Gemini client instance
 */
export function getGeminiClient(): GeminiClient {
  if (!clientInstance) {
    clientInstance = new GeminiClient();
  }
  return clientInstance;
}

/**
 * Reset the client (for testing)
 */
export function resetGeminiClient(): void {
  clientInstance = null;
}
