/**
 * Gemini Client for AsyncThink
 *
 * Direct Gemini API calls for metacognitive collaboration and research.
 * Used alongside Claude Code workers for hybrid async operations.
 *
 * Features:
 * - Gemini 3 Pro for reasoning/feedback/collaboration
 * - File upload for context-rich collaboration
 * - Grounded search (Google Search) for web research
 * - Fast execution (2-5 seconds for quick, 10-30s for deep collaboration)
 */

import { getConfigManager } from './config.js';
import * as fs from 'fs';
import * as path from 'path';

// Default model for Gemini workers (can be changed via config)
const DEFAULT_MODEL = 'gemini-3-pro-preview';

// File processing constants
const FILE_PROCESSING_CHECK_MS = 2000;
const FILE_PROCESSING_TIMEOUT_MS = 60000;

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

export interface CollaborateParams {
  message: string;
  files?: string[];           // Paths to files to upload for context
  context?: string;           // Additional context/explanation
  enableGroundedSearch?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface UploadedFile {
  uri: string;
  name: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  state: string;
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
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.ts': 'text/x-typescript',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.py': 'text/x-python',
      '.html': 'text/html',
      '.css': 'text/css',
      '.yaml': 'text/yaml',
      '.yml': 'text/yaml',
      '.xml': 'application/xml',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    return mimeTypes[ext] || 'text/plain';
  }

  /**
   * Upload a file to Gemini Files API
   */
  async uploadFile(filePath: string): Promise<UploadedFile> {
    const client = await this.getClient();

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const displayName = path.basename(filePath);
    const mimeType = this.getMimeType(filePath);

    console.error(`[GeminiClient] Uploading file: ${displayName} (${mimeType})`);

    const uploadResult = await client.files.upload({
      file: filePath,
      config: {
        mimeType,
        displayName,
      },
    });

    // Wait for file to be processed
    let file = uploadResult;
    const startTime = Date.now();

    while (file.state === 'PROCESSING') {
      if (Date.now() - startTime > FILE_PROCESSING_TIMEOUT_MS) {
        throw new Error(`File processing timeout: ${displayName}`);
      }
      console.error(`[GeminiClient] Waiting for file processing: ${displayName}`);
      await new Promise(resolve => setTimeout(resolve, FILE_PROCESSING_CHECK_MS));
      file = await client.files.get({ name: file.name });
    }

    if (file.state === 'FAILED') {
      throw new Error(`File processing failed: ${displayName}`);
    }

    console.error(`[GeminiClient] File ready: ${displayName} (${file.uri})`);

    return {
      uri: file.uri,
      name: file.name,
      displayName: file.displayName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      state: file.state,
    };
  }

  /**
   * Upload multiple files in parallel
   */
  async uploadFiles(filePaths: string[]): Promise<UploadedFile[]> {
    console.error(`[GeminiClient] Uploading ${filePaths.length} files...`);
    const uploads = filePaths.map(fp => this.uploadFile(fp));
    return Promise.all(uploads);
  }

  /**
   * Collaborate with Gemini using files for context
   * This enables deep, context-rich collaboration where Gemini
   * understands your codebase, documentation, and current state.
   */
  async collaborate(params: CollaborateParams): Promise<GenerateResult> {
    const client = await this.getClient();

    const {
      message,
      files = [],
      context,
      enableGroundedSearch = false,
      maxTokens = 8000,  // Larger default for collaboration
      temperature = 0.7,
      model = this.config?.model || DEFAULT_MODEL,
    } = params;

    // Upload files if provided
    let uploadedFiles: UploadedFile[] = [];
    if (files.length > 0) {
      uploadedFiles = await this.uploadFiles(files);
    }

    // Build the collaboration prompt
    let fullMessage = message;
    if (context) {
      fullMessage = `## Context\n${context}\n\n## Request\n${message}`;
    }

    // Build generation config
    const config: any = {
      temperature,
      maxOutputTokens: maxTokens,
    };

    if (enableGroundedSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    // Build contents with file references
    const parts: any[] = [];

    // Add file references first
    for (const file of uploadedFiles) {
      parts.push({
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      });
    }

    // Add the message
    parts.push({ text: fullMessage });

    const contents = [{ role: 'user', parts }];

    const requestOptions: any = {
      model,
      contents,
      config,
    };

    // Add system instruction for collaboration mode
    requestOptions.systemInstruction = {
      parts: [{
        text: `You are a collaborative thought partner helping to analyze and improve a software project.
You have been given documentation and source files for context.
Provide thoughtful, constructive feedback that considers:
1. The overall architecture and design patterns
2. Potential issues or improvements
3. Alternative approaches worth considering
4. Specific, actionable suggestions

Be direct and specific. Reference the files you were given when relevant.`,
      }],
    };

    console.error(`[GeminiClient] Collaborating with ${uploadedFiles.length} files`);
    console.error(`[GeminiClient] Model: ${model}, grounded search: ${enableGroundedSearch}`);

    try {
      const startTime = Date.now();
      const result = await client.models.generateContent(requestOptions);
      const elapsed = Date.now() - startTime;

      const responseText = result.text || '';
      const usage = result.usageMetadata
        ? {
            promptTokenCount: result.usageMetadata.promptTokenCount || 0,
            candidatesTokenCount: result.usageMetadata.candidatesTokenCount || 0,
            totalTokenCount: result.usageMetadata.totalTokenCount || 0,
          }
        : undefined;

      const groundingMetadata = result.candidates?.[0]?.groundingMetadata;

      console.error(`[GeminiClient] Collaboration response: ${responseText.length} chars in ${elapsed}ms`);
      if (usage) {
        console.error(`[GeminiClient] Tokens: ${usage.totalTokenCount}`);
      }

      return {
        text: responseText,
        usage,
        groundingMetadata,
      };
    } catch (error: any) {
      console.error(`[GeminiClient] Collaboration error:`, error.message);
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
