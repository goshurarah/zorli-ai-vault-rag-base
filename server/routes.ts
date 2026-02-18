import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import Stripe from "stripe";
import OpenAI from "openai";
import {
  insertUserSchema,
  insertFileSchema,
  insertJobSchema,
  userSubscriptions as userSubscriptionsTable,
  subscriptionUsage as subscriptionUsageTable,
  subscriptionPlans as subscriptionPlansTable,
} from "@shared/schema";
import { z } from "zod";
import { fileProcessor } from "./fileProcessor";
import { databaseSearchService } from "./databaseSearchService";
import { subscriptionService, SUBSCRIPTION_PLANS, stripe } from "./subscriptionService";
import { encryptPassword, decryptPassword } from "./encryption";
import { insertAccountCredentialSchema } from "@shared/schema";
import { db } from "./db";
import { sendPasswordResetOTP, sendVerificationEmail } from "./email";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

// Seed subscription plans on startup
async function seedSubscriptionPlans() {
  try {
    // Check if plans already exist
    const existingPlans = await storage.getAllSubscriptionPlans();
    
    if (existingPlans.length === 0) {
      console.log('Seeding subscription plans...');
      
      // Create free plan - $0/month
      await storage.createSubscriptionPlan({
        name: 'free',
        displayName: 'Free Plan',
        description: 'Intelligence for everyday tasks',
        priceMonthly: 0,
        maxFiles: 10,
        maxAIPrompts: 20,
        features: ['Upload 10 files per month', '20 prompts per month'],
      });
      
      // Create plus plan - $20/month
      await storage.createSubscriptionPlan({
        name: 'plus',
        displayName: 'Plus',
        description: 'More access to advanced intelligence',
        priceMonthly: 2000, // $20.00 in cents
        stripePriceId: process.env.STRIPE_PLUS_PRICE_ID || null,
        maxFiles: 100,
        maxAIPrompts: 500,
        features: ['Upload 100 files per month', '500 prompts per month'],
      });
      
      // Create business plan - $25/month
      await storage.createSubscriptionPlan({
        name: 'business',
        displayName: 'Business',
        description: 'Secure, collaborative workspace for teams',
        priceMonthly: 2500, // $25.00 in cents
        stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID || null,
        maxFiles: -1, // unlimited
        maxAIPrompts: -1, // unlimited
        features: ['Unlimited files', 'Unlimited prompts'],
      });
      
      console.log('Subscription plans seeded successfully');
    }
  } catch (error) {
    console.error('Error seeding subscription plans:', error);
  }
}

// RAG document processing function
async function processDocumentForRAG(
  documentId: string,
  userId: string,
  storagePath: string,
  fileType: string,
) {
  try {
    // Import services
    const { SupabaseStorageService, EmbeddingService } = await import(
      "./supabaseService"
    );
    const { textExtractionService } = await import("./textExtraction");
    const supabaseStorage = new SupabaseStorageService();

    // Download file from Supabase Storage
    const fileBuffer = await supabaseStorage.downloadFile(storagePath);

    let textContent = "";

    // Extract text using the enhanced text extraction service for all supported file types
    // Create temporary file from buffer for TextExtractionService using proper async file operations
    const fs = await import("fs/promises");
    const fsSync = await import("fs");
    const path = await import("path");
    const tempDir = path.join(process.cwd(), 'temp');
    
    // Ensure temp directory exists
    if (!fsSync.existsSync(tempDir)) {
      await fs.mkdir(tempDir, { recursive: true });
    }
    
    // Generate unique temporary file path - let textExtractionService handle any file type
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 15);
    const tempFilePath = path.join(tempDir, `file_${documentId}_${timestamp}_${randomId}.tmp`);
    
    try {
      // Write file asynchronously to avoid blocking I/O
      await fs.writeFile(tempFilePath, fileBuffer);
      
      // Use the universal text extraction service for all file types
      // The service will determine proper handling based on file content and MIME type
      const extractionResult = await textExtractionService.extractText(tempFilePath, fileType);
      textContent = extractionResult.content || '';
    } finally {
      // Clean up temporary file asynchronously
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        console.warn('Failed to clean up temp file:', cleanupError);
      }
    }

    if (textContent.trim()) {
      // Import services needed for chunk-based embeddings
      const { embeddingsService } = await import("./embeddingsService");

      // Step 1: Split text into chunks for better semantic search (~500 tokens each)
      const chunks = embeddingsService.createTextChunks(
        textContent,
        documentId,
        userId, // Include userId for security
        500,  // maxTokens (~375 words)
        100,  // overlapTokens (~75 words)
      );

      if (chunks.length > 0) {
        // Step 2: Generate embeddings for each chunk
        const embeddingResults =
          await embeddingsService.generateEmbeddings(chunks);

        // Step 3: Validate all chunks received embeddings (critical for robust processing)
        if (embeddingResults.length !== chunks.length) {
          throw new Error(
            `Embedding generation failed: Expected ${chunks.length} embeddings, got ${embeddingResults.length}`,
          );
        }

        // Step 4: Prepare chunks with embeddings for database storage - only valid chunks
        const chunksWithEmbeddings = chunks.map((chunk) => {
          const embeddingResult = embeddingResults.find(
            (r) => r.chunkId === chunk.id,
          );
          if (!embeddingResult || !embeddingResult.embedding) {
            throw new Error(`Missing embedding for chunk ${chunk.id}`);
          }
          return {
            id: chunk.id,
            fileId: documentId,
            userId: userId,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
            embedding: embeddingResult.embedding,
            metadata: chunk.metadata,
          };
        });

        // Step 5: Store chunks in database (only if ALL have embeddings)
        await storage.addTextChunks(chunksWithEmbeddings);

        // Step 6: Update document with extracted text and completion status
        await storage.updateFile(documentId, {
          extractedText: textContent,
          embeddingStatus: "completed",
        });

        console.log(
          `✅ RAG processing completed for document ${documentId}: ${chunks.length} chunks created with embeddings`,
        );
      } else {
        await storage.updateFile(documentId, {
          extractedText: textContent,
          embeddingStatus: "failed",
        });
        console.log(
          `❌ RAG processing failed for document ${documentId}: Could not create text chunks`,
        );
      }
    } else {
      // Mark as failed if no text could be extracted
      await storage.updateFile(documentId, {
        embeddingStatus: "failed",
      });
      console.log(
        `❌ RAG processing failed for document ${documentId}: No text content extracted`,
      );
    }
  } catch (error) {
    console.error(`RAG processing failed for document ${documentId}:`, error);
    // Mark as failed
    await storage.updateFile(documentId, {
      embeddingStatus: "failed",
    });
  }
}

// Helper function to find relevant files based on natural language query
function findRelevantFiles(query: string, files: any[]): any[] {
  const searchTerms = query.toLowerCase().split(" ");
  const scored = files.map((file) => {
    let score = 0;
    const filename = file.filename.toLowerCase();
    const fileType = file.fileType.toLowerCase();

    // Exact filename matches get highest score
    if (filename.includes(query)) {
      score += 100;
    }

    // Individual term matches
    searchTerms.forEach((term) => {
      if (filename.includes(term)) score += 10;
      if (fileType.includes(term)) score += 5;
    });

    // Common document type mappings
    const typePatterns = {
      license: ["license", "id", "identification"],
      tax: ["tax", "1040", "w2", "w-2", "1099"],
      passport: ["passport"],
      insurance: ["insurance", "policy"],
      contract: ["contract", "agreement"],
      receipt: ["receipt", "invoice"],
      photo: ["jpg", "jpeg", "png", "gif", "photo", "image"],
      document: ["pdf", "doc", "docx", "txt"],
      image: ["jpg", "jpeg", "png", "gif", "webp", "svg"],
    };

    Object.entries(typePatterns).forEach(([category, patterns]) => {
      if (searchTerms.some((term) => patterns.includes(term))) {
        patterns.forEach((pattern) => {
          if (filename.includes(pattern) || fileType.includes(pattern)) {
            score += 20;
          }
        });
      }
    });

    return { ...file, score };
  });

  return scored
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // Return top 10 matches
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Seed subscription plans on startup
  await seedSubscriptionPlans();
  
  // Authentication middleware
  const requireAuth = async (req: any, res: any, next: any) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });
      }

      if (!authHeader.startsWith("Bearer ")) {
        return res
          .status(401)
          .json({ success: false, error: "Invalid token format" });
      }

      const token = authHeader.replace("Bearer ", "");

      // Validate token against database
      const user = await storage.validateAuthSession(token);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, error: "Invalid or expired token" });
      }

      req.userId = user.id;
      req.user = user;
      next();
    } catch (error) {
      return res
        .status(401)
        .json({ success: false, error: "Token validation failed" });
    }
  };

  // Admin role middleware - requires authentication first
  const requireAdmin = async (req: any, res: any, next: any) => {
    try {
      // Ensure user is authenticated first
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, error: "Authentication required" });
      }

      // Check if user has admin role
      if (req.user.role !== "admin") {
        return res
          .status(403)
          .json({ success: false, error: "Admin access required" });
      }

      next();
    } catch (error) {
      return res
        .status(403)
        .json({ success: false, error: "Admin access verification failed" });
    }
  };

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      integrations: {
        stripe: !!stripe,
        openai: !!openai,
        objectStorage: !!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID,
      },
    });
  });
  

  // AI Chat endpoint for natural language file search
  app.post("/api/ai/chat", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { message, conversation } = req.body;

      // Check AI prompt limits from database
      const userSubscription = await storage.getUserSubscription(userId);
      const usage = await storage.getSubscriptionUsage(userId);
      const plan = userSubscription 
        ? await storage.getSubscriptionPlan(userSubscription.planId)
        : null;
      
      const maxAIPrompts = plan?.maxAIPrompts || 20; // Default to free plan limit
      const currentPromptsCount = usage?.aiPromptsCount || 0;
      
      // Check AI prompt limit (skip check if maxAIPrompts is -1, which means unlimited)
      if (maxAIPrompts !== -1 && currentPromptsCount >= maxAIPrompts) {
        return res.status(403).json({
          error: 'AI prompt limit exceeded',
          message: `You've reached your AI prompt limit. Current: ${currentPromptsCount}, Max: ${maxAIPrompts}. Please upgrade your plan to continue.`,
          currentCount: currentPromptsCount,
          maxCount: maxAIPrompts,
          limitType: 'ai_prompts',
        });
      }

      // Validate request with Zod
      const chatRequestSchema = insertJobSchema.pick({ userId: true }).extend({
        message: z.string().min(1).max(1000),
        conversation: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string(),
            }),
          )
          .optional(),
      });

      const validation = chatRequestSchema.safeParse({
        userId: req.userId,
        message,
        conversation,
      });

      if (!validation.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: validation.error.issues,
        });
      }

      const { message: validatedMessage, conversation: validatedConversation } =
        validation.data;

      // Get user's files for general context and vector search filtering
      const userFiles = await storage.getFilesByUserId(userId);
      console.log(`[AI CHAT DEBUG] User ${userId} has ${userFiles.length} files:`, userFiles.map(f => ({ id: f.id, filename: f.filename })));

      // CONVERSATION CONTEXT RESOLUTION: Expand pronouns and references using recent conversation context
      // This enables follow-up questions like "what is his email?" to understand "his" = "Jameel"
      let expandedQuery = validatedMessage;
      
      // Check if the query contains pronouns or references that need context
      const pronounPattern = /\b(his|her|their|its|he|she|they|it|him|them|this|that|these|those|the person|the document|the file)\b/i;
      const hasPronouns = pronounPattern.test(validatedMessage);
      
      if (hasPronouns && validatedConversation && validatedConversation.length > 0) {
        // Extract entities (names, topics) from recent conversation to add context
        // Look at the last 4 messages for context
        const recentContext = validatedConversation.slice(-4);
        
        // Extract potential entity names from recent messages (capitalized words, names mentioned)
        const entityPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
        const mentionedEntities: string[] = [];
        
        for (const msg of recentContext) {
          const matches = msg.content.match(entityPattern) || [];
          // Filter out common words that happen to be capitalized (start of sentences, etc.)
          const commonCapitalized = new Set(['I', 'The', 'This', 'That', 'From', 'According', 'Here', 'Hello', 'Hi', 'Based', 'If', 'You']);
          for (const match of matches) {
            if (!commonCapitalized.has(match) && match.length > 2) {
              mentionedEntities.push(match);
            }
          }
        }
        
        // Get unique entities, preferring recent mentions
        const uniqueEntities = Array.from(new Set(mentionedEntities.reverse())).slice(0, 3);
        
        if (uniqueEntities.length > 0) {
          // Append the most recently mentioned entity to the query for better search
          const contextAddition = uniqueEntities.join(' ');
          expandedQuery = `${validatedMessage} (context: ${contextAddition})`;
          console.log(`[CONTEXT RESOLUTION] Original: "${validatedMessage}" -> Expanded: "${expandedQuery}"`);
          console.log(`[CONTEXT RESOLUTION] Detected entities from conversation: ${uniqueEntities.join(', ')}`);
        }
      }

      // Use vector search for semantic RAG retrieval
      let relevantContent: {
        text: string;
        filename: string;
        fileId: string;
        score: number;
        sourceType: string;
      }[] = [];

      try {
        // Import services needed for vector search
        const { embeddingsService } = await import("./embeddingsService");
        const { vectorDatabase } = await import("./vectorDatabase");

        if (!embeddingsService.isAvailable()) {
          console.warn("OpenAI API not configured - falling back to basic search");
          
          // Fallback to basic database search if embeddings not available
          const searchResults = await databaseSearchService.searchDocuments(
            userId,
            validatedMessage,
            5
          );
          
          relevantContent = searchResults.map((result) => ({
            text: result.extractedText,
            filename: result.filename,
            fileId: result.id,
            score: result.relevanceScore,
            sourceType: 'database_document'
          }));
        } else {
          // Generate embedding for the user's query (use expanded query for better context)
          console.log(`Generating embedding for query: "${expandedQuery}"`);
          const queryEmbedding = await embeddingsService.generateEmbeddings([{
            id: 'query',
            fileId: 'query',
            userId: userId, // Include userId for the query chunk
            content: expandedQuery,
            chunkIndex: 0
          }]);

          if (queryEmbedding.length > 0) {
            // Perform vector similarity search with strict user isolation
            const vectorResults = await vectorDatabase.search({
              text: expandedQuery,
              embedding: queryEmbedding[0].embedding,
              userId: userId, // CRITICAL: Filter by userId for security
              fileIds: userFiles.map(f => f.id), // Additional filter by user's files
              limit: 20, // Get more results, we'll take top 5
              threshold: 0.45 // Only accept results with meaningful relevance (0.45+ similarity)
            });

            console.log(`Vector search returned ${vectorResults.length} results for query: "${expandedQuery}"`);

            if (vectorResults.length > 0) {
              // Extract significant keywords from the EXPANDED query (includes context entities)
              const commonWords = new Set(['the', 'what', 'how', 'where', 'when', 'why', 'who', 'which', 'can', 'you', 
                'tell', 'about', 'please', 'help', 'find', 'show', 'get', 'give', 'know', 'is', 'are', 'was', 'were',
                'have', 'has', 'had', 'will', 'would', 'could', 'should', 'may', 'might', 'and', 'or', 'but', 'for',
                'some', 'any', 'all', 'more', 'most', 'other', 'such', 'into', 'from', 'with', 'this', 'that', 'these',
                'those', 'your', 'my', 'our', 'their', 'its', 'his', 'her', 'me', 'him', 'them', 'us', 'be', 'been',
                'context']); // Added 'context' since we add it in the expanded query
              
              // Normalize query words: remove possessive 's, trailing 's, etc. for better matching
              const queryWords = expandedQuery.toLowerCase()
                .replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 3)
                .map(w => w.replace(/'s$/, '').replace(/s$/, '')); // Remove possessive and plural 's
              const significantQueryTerms = queryWords.filter(w => !commonWords.has(w));
              
              console.log(`Significant query terms for lexical filter: ${significantQueryTerms.join(', ')}`);
              
              // Filter vector results to only include chunks that contain significant query terms
              // This prevents "Lahore weather" from matching chunks that only have "weather" but not "Lahore"
              const filteredResults = vectorResults.filter(result => {
                const chunkTextLower = result.chunk.content.toLowerCase();
                
                // Check for term matches with stemming tolerance
                const matchedTerms = significantQueryTerms.filter(term => {
                  // Direct match
                  if (chunkTextLower.includes(term)) return true;
                  // Match without trailing 's' (handles maryam vs maryams)
                  if (chunkTextLower.includes(term.replace(/s$/, ''))) return true;
                  // Check if term root appears (at least 4 chars)
                  if (term.length >= 4) {
                    const termRoot = term.substring(0, Math.max(4, term.length - 2));
                    if (chunkTextLower.includes(termRoot)) return true;
                  }
                  return false;
                });
                
                const matchRatio = significantQueryTerms.length > 0 ? matchedTerms.length / significantQueryTerms.length : 1;
                
                // Require at least 50% of significant terms to be present (more lenient for name matching)
                const passesFilter = matchRatio >= 0.5;
                
                if (!passesFilter) {
                  const missingTerms = significantQueryTerms.filter(t => !matchedTerms.includes(t));
                  console.log(`Filtered out chunk (matchRatio=${matchRatio.toFixed(2)}, similarity=${result.similarity.toFixed(2)}): missing terms "${missingTerms.join(', ')}"`);
                }
                
                return passesFilter;
              });
              
              console.log(`After lexical filter: ${filteredResults.length} of ${vectorResults.length} results remain`);
              
              // Use filtered results - take top 5
              relevantContent = await Promise.all(filteredResults.slice(0, 5).map(async (result) => {
                const fileData = userFiles.find(f => f.id === result.chunk.fileId);
                
                // SECURITY: This should never happen due to userId filtering, but verify
                if (!fileData) {
                  console.error(`SECURITY WARNING: Chunk ${result.chunk.id} with fileId ${result.chunk.fileId} not found in user's files!`);
                  return null;
                }
                
                return {
                  text: result.chunk.content,
                  filename: fileData.filename,
                  fileId: result.chunk.fileId,
                  score: result.similarity,
                  sourceType: 'vector_chunk'
                };
              })).then(results => results.filter(r => r !== null)) as any;

              // Debug logging for top 5 filtered results
              filteredResults.slice(0, 5).forEach((result, index) => {
                const fileData = userFiles.find(f => f.id === result.chunk.fileId);
                if (fileData) {
                  console.log(`Top Result ${index + 1}: similarity=${result.similarity.toFixed(3)}, file="${fileData.filename}", preview="${result.chunk.content.substring(0, 100)}..."`);
                } else {
                  console.error(`SECURITY WARNING: Result ${index + 1} has invalid fileId ${result.chunk.fileId}`);
                }
              });
            }
          }
        }

        console.log(
          `Found ${relevantContent.length} relevant content chunks for query: "${expandedQuery}"`,
        );
      } catch (error) {
        console.warn(
          "Vector search failed, falling back to database search:",
          error,
        );
        
        // Fallback to basic database search
        try {
          const searchResults = await databaseSearchService.searchDocuments(
            userId,
            validatedMessage,
            5
          );
          
          relevantContent = searchResults.map((result) => ({
            text: result.extractedText,
            filename: result.filename,
            fileId: result.id,
            score: result.relevanceScore,
            sourceType: 'database_document'
          }));
        } catch (fallbackError) {
          console.error("Both vector and database search failed:", fallbackError);
        }
      }

      // Create structured context from search results
      let contextInfo = "";

      if (relevantContent.length > 0) {
        // We have chunks - build context with top 5 chunks
        contextInfo += "RELEVANT DOCUMENT CONTENT:\n";
        relevantContent.slice(0, 5).forEach((chunk, index) => {
          // Vector similarity scores are already 0-1, database scores need normalization
          const normalizedScore = chunk.sourceType === 'vector_chunk' 
            ? chunk.score 
            : Math.min(chunk.score / 10, 1.0);
          
          contextInfo += `${index + 1}. From "${chunk.filename}" (similarity: ${(normalizedScore * 100).toFixed(1)}%):\n${chunk.text}\n\n`;
        });
      } else if (userFiles.length > 0) {
        // No chunks found but user has files - fallback to filename listing
        contextInfo += "AVAILABLE FILES:\n";
        userFiles.forEach((file, index) => {
          contextInfo += `${index + 1}. ${file.filename} (${file.fileType})\n`;
        });
        contextInfo += "\nNote: No specific content chunks were found for your query in these files.\n";
      }

      // Build the enhanced system prompt for RAG responses
      const systemPrompt =
        userFiles.length === 0
          ? `You are a friendly document assistant. The user hasn't uploaded any documents yet.

Be polite and conversational. Respond to greetings naturally and encourage them to upload documents.

Example responses:
- For greetings: "Hello! I'm your document assistant. I can help you analyze and search through your files once you upload them. What would you like to work on today?"
- For questions: "I'd be happy to help! Please upload some documents first, and I'll be able to answer questions about them."`
          : relevantContent.length > 0
          ? `You are a friendly and helpful document assistant. Your primary job is to help users understand and work with their uploaded documents.

USER'S DOCUMENT LIBRARY:
Total files uploaded: ${userFiles.length}
Files: ${userFiles.map(f => f.filename).join(', ')}

${contextInfo}

IMPORTANT - PERSONAL INFORMATION POLICY:
The user has uploaded their own documents and has full rights to access ALL information in them.
You MUST provide any information found in the documents when asked, including:
- Phone numbers, email addresses, contact details
- Names, addresses, personal identifiers
- Salaries, financial information
- Any other personal or sensitive data

These are the user's OWN documents - they have every right to access this information. Never refuse to share information that exists in their uploaded files.

CRITICAL INSTRUCTION - ANSWER ONLY IF CONTENT DIRECTLY MATCHES:
I have searched the user's documents and found content that may be relevant. Review this content carefully.

DECISION LOGIC:
1. If the content above DIRECTLY answers the user's question → Answer using that content with citations
2. If the content is only TANGENTIALLY related (same topic but different context) → Say "I couldn't find information about [specific query] in your documents"
3. DO NOT mention tangentially related content - only answer if it directly addresses the question

EXAMPLES:
- User asks "Lahore weather" but content is about "US weather" → Say "I couldn't find information about Lahore weather in your documents"
- User asks "Lahore weather" and content mentions "Lahore weather" → Answer from the content
- User asks about "John's salary" but content mentions "Jane's salary" → Say "I couldn't find John's salary in your documents"

RESPONSE APPROACH:
1. **Check if content DIRECTLY answers the question**
   - All key terms in the question should be addressed in the content
   - If content doesn't directly match, respond with: "I couldn't find information about [their specific question] in your uploaded documents."

2. **If content directly matches**: Answer using the provided content with citations
   - Always cite the source: "According to [filename]..." or "From [filename]..."

3. **For greetings/small talk**: Respond naturally and mention available documents

4. **For CSV/XLSX/tabular data**: Present data clearly if it matches the query

CITATION FORMATS:
- "According to [filename]: [specific information]"
- "Based on your [filename], I found: [present data clearly]"
- "From [filename]: [exact quote or data]"

IMPORTANT: Do NOT mention tangentially related content. If the user asks about X and you only have content about Y (even if related), simply say you couldn't find information about X.

Be helpful but precise - only answer from content that directly addresses the user's question.`
          : `You are a friendly document assistant. I searched through your uploaded files but couldn't find specific content matching your query.

${contextInfo}

IMPORTANT - PERSONAL INFORMATION POLICY:
The user has uploaded their own documents and has full rights to access ALL information in them.
You MUST provide any information found in the documents when asked, including phone numbers, email addresses, contact details, names, addresses, salaries, and any other personal data. These are the user's OWN documents.

IMPORTANT: You are specialized in helping users with their uploaded documents only. Do not answer general knowledge questions, trivia, or questions unrelated to the uploaded files.

RESPONSE APPROACH:
1. **For greetings**: Respond warmly and mention available files
   - Example: "Hello! I can see you have ${userFiles.length} file(s) uploaded: ${userFiles.slice(0, 3).map(f => f.filename).join(', ')}${userFiles.length > 3 ? '...' : ''}. How can I help you with them?"

2. **For document-related questions**: Be helpful and suggest what you can do
   - Example: "I searched through your files but couldn't find that specific information. However, I can see you have [list files]. Would you like me to help you with something else from these documents?"

3. **For general knowledge/unrelated questions**: Politely decline and redirect
   - Example: "I'm specialized in helping with your uploaded documents and can't answer general questions. I can see you have [list files]. What would you like to know about them?"

4. **File processing note**: If files are recently uploaded, mention they might still be processing

Be conversational and helpful, but stay focused on the user's documents.`;

      // Database-only mode: No file analysis needed

      let aiResponse = "";

      if (!openai) {
        // Strict database-only fallback when OpenAI is not available
        if (relevantContent.length > 0) {
          // Build response from database content only
          aiResponse = relevantContent.map((content, index) => 
            `From your file '${content.filename}': ${content.text.substring(0, 200)}${content.text.length > 200 ? '...' : ''}`
          ).join('\n\n');
        } else {
          aiResponse = `Sorry, I can only answer questions related to your uploaded documents. I don't see that information in your files. (AI analysis temporarily unavailable)`;
        }
      } else {
        // Prepare the conversation for OpenAI
        const messages = [
          { role: "system", content: systemPrompt },
          ...(validatedConversation || []),
          { role: "user", content: validatedMessage },
        ];

        // Debug logging for AI context
        console.log(`System prompt length: ${systemPrompt.length} characters`);
        console.log(`Relevant content chunks: ${relevantContent.length}`);
        if (relevantContent.length > 0) {
          console.log(`First chunk preview: "${relevantContent[0].text.substring(0, 200)}..."`);
        }

        try {
          // Call OpenAI API
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages as any,
            max_tokens: 500,
            temperature: 0.7,
          });

          aiResponse =
            completion.choices[0]?.message?.content ||
            "Sorry, I could not process your request.";
        } catch (openaiError) {
          console.error("OpenAI API error:", openaiError);
          // Strict database-only fallback when OpenAI fails
          if (relevantContent.length > 0) {
            // Build response from database content only
            aiResponse = relevantContent.map((content) => 
              `From your file '${content.filename}': ${content.text.substring(0, 200)}${content.text.length > 200 ? '...' : ''}`
            ).join('\n\n');
          } else {
            aiResponse = `Sorry, I can only answer questions related to your uploaded documents. I don't see that information in your files. (AI analysis temporarily unavailable)`;
          }
        }
      }

      // Database-only mode: Never return file listings, only citations for used documents
      const filesToReturn: any[] = [];

      // Create citation information for sources used by the AI
      const citations = relevantContent.map((content) => ({
        documentId: content.fileId,
        filename: content.filename,
        sourceType: content.sourceType,
        relevanceScore: content.score,
        preview:
          content.text.substring(0, 100) +
          (content.text.length > 100 ? "..." : ""),
      }));

      // Increment AI prompt counter for subscription usage tracking
      try {
        await storage.incrementAIPromptCount(userId);
      } catch (usageError) {
        console.error('Failed to update prompt usage counter:', usageError);
        // Don't fail the request if usage tracking fails
      }

      res.json({
        message: aiResponse,
        files: [], // Database-only mode: never return file listings
        citations: citations, // Include source citations for transparency
        hasRelevantContent: relevantContent.length > 0, // Indicate if database content was found
      });
    } catch (error) {
      console.error("AI chat error:", error);
      res.status(500).json({ error: "Failed to process chat request" });
    }
  });

  // AI Transcription endpoint for voice input (OpenAI Whisper)
  app.post("/api/ai/transcribe", requireAuth, upload.single('audio'), async (req: any, res) => {
    try {
      if (!openai) {
        return res.status(503).json({ 
          error: "OpenAI API not configured. Speech transcription unavailable." 
        });
      }

      if (!req.file) {
        return res.status(400).json({ 
          error: "No audio file provided" 
        });
      }

      const { buffer, mimetype, originalname } = req.file;

      // Validate audio file type
      const supportedTypes = [
        'audio/webm', 'audio/mp3', 'audio/wav', 'audio/m4a', 
        'audio/mp4', 'audio/mpeg', 'audio/mpga'
      ];
      
      if (!supportedTypes.includes(mimetype)) {
        return res.status(400).json({ 
          error: `Unsupported audio format: ${mimetype}. Supported formats: ${supportedTypes.join(', ')}` 
        });
      }

      // Create a temporary file from buffer for OpenAI API
      const fs = await import('fs/promises');
      const path = await import('path');
      const crypto = await import('crypto');
      
      const tempFileName = `audio_${crypto.randomUUID()}.webm`;
      const tempFilePath = path.join('/tmp', tempFileName);
      
      try {
        // Write buffer to temporary file
        await fs.writeFile(tempFilePath, buffer);
        
        // Create readable stream for OpenAI API
        const fileStream = await import('fs').then(fs => fs.createReadStream(tempFilePath));
        
        // Call OpenAI Whisper API
        const transcription = await openai.audio.transcriptions.create({
          file: fileStream,
          model: 'whisper-1',
          language: 'en', // Can be made configurable
          response_format: 'text'
        });
        
        // Clean up temporary file
        await fs.unlink(tempFilePath);
        
        res.json({ 
          success: true, 
          text: transcription || '',
          message: 'Audio transcribed successfully' 
        });
        
      } catch (fileError) {
        // Ensure cleanup even if error occurs
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.warn('Failed to clean up temp file:', cleanupError);
        }
        throw fileError;
      }
      
    } catch (error) {
      console.error('Transcription error:', error);
      
      let errorMessage = 'Failed to transcribe audio';
      if (error instanceof Error) {
        if (error.message.includes('Invalid file format')) {
          errorMessage = 'Invalid audio file format. Please try a different file.';
        } else if (error.message.includes('File too large')) {
          errorMessage = 'Audio file too large. Maximum size is 25MB.';
        } else if (error.message.includes('No speech found')) {
          errorMessage = 'No speech detected in the audio. Please try speaking more clearly.';
        }
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined
      });
    }
  });

  // Authentication routes
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { firstName, lastName, email, password } = req.body;

      // Trim all fields to remove any whitespace
      const trimmedFirstName = firstName?.trim();
      const trimmedLastName = lastName?.trim();
      const trimmedEmail = email?.trim();
      const trimmedPassword = password?.trim();

      if (!trimmedFirstName || !trimmedLastName || !trimmedEmail || !trimmedPassword) {
        return res.status(400).json({
          success: false,
          error: "All fields are required",
        });
      }

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(trimmedEmail);
      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: "User with this email already exists",
        });
      }

      // Generate username from first name and last name
      const baseUsername = `${trimmedFirstName} ${trimmedLastName}`;
      let username = baseUsername;
      let counter = 1;

      // Ensure username is unique
      while (await storage.getUserByUsername(username)) {
        username = `${baseUsername} ${counter}`;
        counter++;
      }

      // Create user
      const userData = insertUserSchema.parse({
        email: trimmedEmail,
        username,
        password: trimmedPassword, // This will be hashed by storage layer
      });

      const user = await storage.createUser(userData);

      // Generate email verification token (secure random string)
      const { randomBytes } = await import('crypto');
      const verificationToken = randomBytes(32).toString('hex');
      
      // Set token expiry to 30 minutes from now
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      
      // Store verification token in database
      await storage.setEmailVerificationToken(user.id, verificationToken, expiresAt);
      
      // Send verification email
      const baseUrl = req.headers.origin || `${req.protocol}://${req.get('host')}`;
      const emailSent = await sendVerificationEmail(trimmedEmail, verificationToken, baseUrl);
      
      if (!emailSent) {
        console.error('❌ Failed to send verification email to:', trimmedEmail);
        // Continue anyway - user can request a new verification email later
      } else {
        console.log('✅ Verification email sent successfully to:', trimmedEmail);
      }

      // Return success WITHOUT token - user needs to verify email first
      res.json({
        success: true,
        message: "Account created successfully. Please check your email to verify your account and login.",
        data: {
          email: trimmedEmail,
          verificationSent: emailSent
        },
      });
    } catch (error) {
      console.error("Signup error:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to create account" });
    }
  });

  // Email verification endpoint
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const { token } = req.query;
      
      if (!token || typeof token !== 'string') {
        return res.status(400).json({
          success: false,
          error: "Verification token is required",
        });
      }
      
      // Find user by verification token
      const user = await storage.getUserByEmailVerificationToken(token);
      
      if (!user) {
        return res.status(400).json({
          success: false,
          error: "Invalid or expired verification token",
        });
      }
      
      // Check if token has expired
      if (user.emailVerificationExpires && new Date() > user.emailVerificationExpires) {
        return res.status(400).json({
          success: false,
          error: "Verification token has expired. Please sign up again or contact support.",
        });
      }
      
      // Mark email as verified and clear verification fields
      await storage.markEmailAsVerified(user.id);
      
      // Create auth session for auto-login
      const authToken = await storage.createAuthSession(user.id);
      
      console.log('✅ Email verified and user logged in:', user.email);
      
      // Don't send password back
      const { password: _, ...userResponse } = user;
      
      res.json({
        success: true,
        message: "Email verified successfully! You are now logged in.",
        data: {
          user: userResponse,
          token: authToken,
        },
      });
    } catch (error) {
      console.error("Email verification error:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to verify email" 
      });
    }
  });

  app.post("/api/auth/signin", async (req, res) => {
    try {
      const { email, password } = req.body;

      // Trim email and password to remove any whitespace
      const trimmedEmail = email?.trim();
      const trimmedPassword = password?.trim();

      console.log("🔐 Signin attempt - Email:", trimmedEmail);

      if (!trimmedEmail || !trimmedPassword) {
        console.log("❌ Missing email or password");
        return res.status(400).json({
          success: false,
          error: "Email and password are required",
        });
      }

      // Find user by email
      const user = await storage.getUserByEmail(trimmedEmail);
      console.log("👤 User found:", user ? `Yes (${user.email})` : "No");
      
      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Invalid email or password",
        });
      }

      // Verify password using bcrypt
      const isPasswordValid = await storage.verifyPassword(trimmedPassword, user.password);
      console.log("🔑 Password valid:", isPasswordValid);
      
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: "Invalid email or password",
        });
      }

      // Check if email is verified
      if (!user.isEmailVerified) {
        console.log("❌ Email not verified for:", user.email);
        return res.status(403).json({
          success: false,
          error: "Please verify your email before signing in. Check your inbox for the verification link.",
        });
      }

      // Create a secure auth session
      const token = await storage.createAuthSession(user.id);

      // Don't send password back
      const { password: _, ...userResponse } = user;

      console.log("✅ Signin successful for:", user.email);
      
      res.json({
        success: true,
        message: "Signed in successfully",
        data: {
          user: userResponse,
          token,
        },
      });
    } catch (error) {
      console.error("Signin error:", error);
      res.status(500).json({ success: false, error: "Failed to sign in" });
    }
  });

  app.post("/api/auth/validate", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Invalid token format",
        });
      }

      const token = authHeader.replace("Bearer ", "");

      // Validate token against database
      const user = await storage.validateAuthSession(token);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired token",
        });
      }

      // Check if email is verified
      if (!user.isEmailVerified) {
        // Revoke the session for unverified users
        await storage.revokeAuthSession(token);
        return res.status(403).json({
          success: false,
          error: "Email not verified. Please check your inbox for the verification link.",
        });
      }

      // Don't send password back
      const { password: _, ...userResponse } = user;

      res.json({
        success: true,
        data: { user: userResponse },
      });
    } catch (error) {
      console.error("Token validation error:", error);
      res
        .status(401)
        .json({ success: false, error: "Token validation failed" });
    }
  });

  app.post("/api/auth/logout", requireAuth, async (req: any, res) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace("Bearer ", "");
      
      if (token) {
        // Revoke the current session
        await storage.revokeAuthSession(token);
      }
      
      res.json({
        success: true,
        message: "Logged out successfully"
      });
    } catch (error) {
      console.error("Logout error:", error);
      res.status(500).json({ success: false, error: "Failed to logout" });
    }
  });

  // Forgot Password - Request OTP
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: "Email is required"
        });
      }

      const trimmedEmail = email.trim().toLowerCase();

      // Check if user exists
      const user = await storage.getUserByEmail(trimmedEmail);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: "No account found with this email address"
        });
      }

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // Set expiry to 10 minutes from now
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // Delete any existing password reset requests for this email
      await storage.deletePasswordResetByEmail(trimmedEmail);

      // Store OTP in password_resets table
      await storage.createPasswordReset({
        email: trimmedEmail,
        otp,
        expiresAt
      });

      // Send OTP email
      const emailSent = await sendPasswordResetOTP(trimmedEmail, otp);

      if (!emailSent) {
        return res.status(500).json({
          success: false,
          error: "Failed to send reset email. Please try again."
        });
      }

      res.json({
        success: true,
        message: "Password reset code sent to your email"
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to process password reset request"
      });
    }
  });

  // Reset Password - Verify OTP and update password
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { email, otp, newPassword } = req.body;

      if (!email || !otp || !newPassword) {
        return res.status(400).json({
          success: false,
          error: "Email, OTP, and new password are required"
        });
      }

      const trimmedEmail = email.trim().toLowerCase();
      const trimmedOtp = otp.trim();

      // Verify OTP
      const resetRequest = await storage.getPasswordResetByEmailAndOtp(trimmedEmail, trimmedOtp);

      if (!resetRequest) {
        return res.status(400).json({
          success: false,
          error: "Invalid or expired OTP. Please try again."
        });
      }

      // Check if OTP is expired
      if (new Date() > new Date(resetRequest.expiresAt)) {
        await storage.deletePasswordResetById(resetRequest.id);
        return res.status(400).json({
          success: false,
          error: "Invalid or expired OTP. Please try again."
        });
      }

      // Get user
      const user = await storage.getUserByEmail(trimmedEmail);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found"
        });
      }

      // Update password
      await storage.updateUserPassword(user.id, newPassword);

      // Delete the used OTP
      await storage.deletePasswordResetById(resetRequest.id);

      res.json({
        success: true,
        message: "Your password has been reset successfully. Please sign in again."
      });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to reset password"
      });
    }
  });

  // User routes
  app.post("/api/users", async (req, res) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      const user = await storage.createUser(userData);
      // Don't send password back
      const { password, ...userResponse } = user;
      res.json({ success: true, data: userResponse });
    } catch (error) {
      res.status(400).json({ success: false, error: "Invalid user data" });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }
      const { password, ...userResponse } = user;
      res.json({ success: true, data: userResponse });
    } catch (error) {
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  // Profile picture upload endpoint
  app.post(
    "/api/user/profile-picture",
    requireAuth,
    upload.single("profilePicture"),
    async (req: any, res) => {
      try {
        const userId = req.userId;
        const file = req.file as Express.Multer.File;

        if (!file) {
          return res
            .status(400)
            .json({ success: false, error: "No file provided" });
        }

        // Validate file type - only allow images
        const allowedTypes = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/gif",
          "image/webp",
        ];

        if (!file.mimetype || !allowedTypes.includes(file.mimetype)) {
          return res.status(400).json({
            success: false,
            error: `File type ${file.mimetype} is not supported. Please upload an image file (JPEG, PNG, GIF, or WebP).`,
          });
        }

        // Validate file size - max 5MB for profile pictures
        if (file.size > 5 * 1024 * 1024) {
          return res.status(400).json({
            success: false,
            error: "File size must be less than 5MB",
          });
        }

        // Generate relative storage path for profile picture
        const timestamp = Date.now();
        const sanitizedFilename = file.originalname.replace(
          /[^a-zA-Z0-9._-]/g,
          "_",
        );
        const relativeStoragePath = `users/${userId}/profile-pictures/profile_${timestamp}_${sanitizedFilename}`;

        // Upload file to Supabase Storage
        const { SupabaseStorageService } = await import("./supabaseService");
        const supabaseStorage = new SupabaseStorageService();
        
        await supabaseStorage.uploadFile(
          relativeStoragePath,
          file.buffer,
          file.mimetype
        );
        
        // Store the storage path (not signed URL) for on-demand URL generation
        const profilePictureUrl = relativeStoragePath;

        // Update user profile with the storage path
        const updatedUser = await storage.updateUserProfile(userId, {
          profilePictureUrl,
        });

        const { password, ...userResponse } = updatedUser;

        res.json({
          success: true,
          data: userResponse,
          message: "Profile picture updated successfully",
        });
      } catch (error) {
        console.error("Profile picture upload error:", error);
        res.status(500).json({
          success: false,
          error: "Failed to upload profile picture",
        });
      }
    },
  );

  // Remove profile picture endpoint
  app.delete("/api/user/profile-picture", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;

      // Update user profile to remove picture
      const updatedUser = await storage.updateUserProfile(userId, {
        profilePictureUrl: undefined,
      });

      const { password, ...userResponse } = updatedUser;

      res.json({
        success: true,
        data: userResponse,
        message: "Profile picture removed successfully",
      });
    } catch (error) {
      console.error("Profile picture removal error:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to remove profile picture" });
    }
  });

  // Update username endpoint
  app.put("/api/user/username", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { username } = req.body;

      if (!username || typeof username !== "string") {
        return res.status(400).json({
          success: false,
          error: "Username is required",
        });
      }

      // Validate username format
      const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
      if (!usernameRegex.test(username)) {
        return res.status(400).json({
          success: false,
          error:
            "Username must be 3-20 characters long and contain only letters, numbers, and underscores",
        });
      }

      // Check if username already exists (for a different user)
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser && existingUser.id !== userId) {
        return res.status(409).json({
          success: false,
          error: "Username is already taken",
        });
      }

      // Update user profile with the new username
      const updatedUser = await storage.updateUserProfile(userId, {
        username,
      });

      const { password, ...userResponse } = updatedUser;

      res.json({
        success: true,
        data: userResponse,
        message: "Username updated successfully",
      });
    } catch (error) {
      console.error("Username update error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update username",
      });
    }
  });

  // Admin endpoints - protected by requireAuth and requireAdmin
  
  // Get subscription statistics
  app.get("/api/admin/subscription-stats", requireAuth, requireAdmin, async (req: any, res) => {
    try {
      const stats = await storage.getSubscriptionCountsByStatus();
      res.json({ 
        success: true, 
        data: stats
      });
    } catch (error: any) {
      console.error("Error getting subscription stats:", error);
      res.status(500).json({ success: false, error: "Failed to get subscription statistics" });
    }
  });

  // Get usage statistics
  app.get("/api/admin/usage-stats", requireAuth, requireAdmin, async (req: any, res) => {
    try {
      const stats = await storage.getUsageTotals();
      res.json({ 
        success: true, 
        data: stats
      });
    } catch (error: any) {
      console.error("Error getting usage stats:", error);
      res.status(500).json({ success: false, error: "Failed to get usage statistics" });
    }
  });

  app.get("/api/admin/users", requireAuth, requireAdmin, async (req: any, res) => {
    try {
      const [users, allSubscriptions, allUsage, plans] = await Promise.all([
        storage.getAllUsers(),
        db.select().from(userSubscriptionsTable),
        db.select().from(subscriptionUsageTable),
        db.select().from(subscriptionPlansTable)
      ]);

      // Create maps for quick lookup
      const subscriptionMap = new Map(allSubscriptions.map(s => [s.userId, s]));
      const usageMap = new Map(allUsage.map(u => [u.userId, u]));
      const planMap = new Map(plans.map(p => [p.id, p]));

      // Enrich user data with subscription and usage info
      const enrichedUsers = users.map(({ password, ...user }) => {
        const subscription = subscriptionMap.get(user.id);
        const usage = usageMap.get(user.id);
        const plan = subscription?.planId ? planMap.get(subscription.planId) : null;

        return {
          ...user,
          subscription: subscription ? {
            planId: subscription.planId,
            planName: plan?.displayName || 'Free',
            status: subscription.status,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd
          } : {
            planId: 'free',
            planName: 'Free',
            status: 'active',
            stripeSubscriptionId: null,
            currentPeriodStart: null,
            currentPeriodEnd: null
          },
          usage: usage ? {
            filesCount: usage.filesCount,
            aiPromptsCount: usage.aiPromptsCount,
            passwordsCount: usage.passwordsCount,
            storageUsedBytes: usage.storageUsedBytes
          } : {
            filesCount: 0,
            aiPromptsCount: 0,
            passwordsCount: 0,
            storageUsedBytes: 0
          },
          limits: plan ? {
            maxFiles: plan.maxFiles,
            maxAIPrompts: plan.maxAIPrompts
          } : {
            maxFiles: 10,
            maxAIPrompts: 20
          }
        };
      });

      res.json({ success: true, data: enrichedUsers });
    } catch (error) {
      console.error("Get all users error:", error);
      res.status(500).json({ success: false, error: "Failed to fetch users" });
    }
  });

  app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req: any, res) => {
    try {
      const userId = req.params.id;
      
      // Prevent admin from deleting themselves
      if (userId === req.userId) {
        return res.status(400).json({ 
          success: false, 
          error: "Cannot delete your own account" 
        });
      }

      // Verify user exists before deleting
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          error: "User not found" 
        });
      }

      // Prevent admin from deleting other admin users
      if (user.role === 'admin') {
        return res.status(403).json({ 
          success: false, 
          error: "Cannot delete admin users" 
        });
      }

      await storage.deleteUser(userId);
      res.json({ 
        success: true, 
        message: `User ${user.username} deleted successfully` 
      });
    } catch (error) {
      console.error("Delete user error:", error);
      res.status(500).json({ success: false, error: "Failed to delete user" });
    }
  });

  // Get all payments for admin dashboard
  app.get("/api/admin/payments", requireAuth, requireAdmin, async (req: any, res) => {
    try {
      const { eq, desc } = await import('drizzle-orm');
      const { payments: paymentsTable, users: usersTable } = await import('@shared/schema');
      
      // Fetch all payments with user information
      const allPayments = await db
        .select({
          id: paymentsTable.id,
          paymentId: paymentsTable.paymentId,
          userId: paymentsTable.userId,
          plan: paymentsTable.plan,
          amount: paymentsTable.amount,
          currency: paymentsTable.currency,
          status: paymentsTable.status,
          subscriptionId: paymentsTable.subscriptionId,
          invoiceId: paymentsTable.invoiceId,
          periodStart: paymentsTable.periodStart,
          periodEnd: paymentsTable.periodEnd,
          createdAt: paymentsTable.createdAt,
          userEmail: usersTable.email,
          username: usersTable.username,
        })
        .from(paymentsTable)
        .leftJoin(usersTable, eq(paymentsTable.userId, usersTable.id))
        .orderBy(desc(paymentsTable.createdAt));

      // Format the data for the frontend
      const formattedPayments = allPayments.map(payment => ({
        id: payment.id,
        paymentId: payment.paymentId,
        userId: payment.userId,
        userEmail: payment.userEmail,
        username: payment.username,
        plan: payment.plan,
        amount: payment.amount, // Amount in dollars
        amountUSD: payment.amount.toFixed(2), // Format as USD
        currency: payment.currency,
        status: payment.status,
        subscriptionId: payment.subscriptionId,
        invoiceId: payment.invoiceId,
        periodStart: payment.periodStart,
        periodEnd: payment.periodEnd,
        createdAt: payment.createdAt,
      }));

      res.json({ success: true, data: formattedPayments });
    } catch (error) {
      console.error("Get all payments error:", error);
      res.status(500).json({ success: false, error: "Failed to fetch payments" });
    }
  });

  // File routes (protected)
  app.get("/api/files", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const files = await storage.getFilesByUserId(userId, limit, offset);
      res.json({ success: true, data: files });
    } catch (error) {
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  // Dashboard metrics endpoint
  app.get("/api/dashboard/metrics", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const metrics = await storage.getDashboardMetrics(userId);
      res.json({ success: true, data: metrics });
    } catch (error) {
      console.error("Dashboard metrics error:", error);
      res.status(500).json({ success: false, error: "Failed to fetch dashboard metrics" });
    }
  });

  app.post(
    "/api/files/upload",
    requireAuth,
    upload.array("files"),
    async (req: any, res) => {
      try {
        const userId = req.userId;
        const files = req.files as Express.Multer.File[];

        if (!files || files.length === 0) {
          return res
            .status(400)
            .json({ success: false, error: "No files provided" });
        }

        // Check file upload limits from database
        const userSubscription = await storage.getUserSubscription(userId);
        const usage = await storage.getSubscriptionUsage(userId);
        const plan = userSubscription 
          ? await storage.getSubscriptionPlan(userSubscription.planId)
          : null;
        
        const maxFiles = plan?.maxFiles || 10; // Default to free plan limit
        const currentFilesCount = usage?.filesCount || 0;
        
        // Check file limit (skip check if maxFiles is -1, which means unlimited)
        if (maxFiles !== -1 && currentFilesCount + files.length > maxFiles) {
          return res.status(403).json({
            error: 'File upload limit exceeded',
            message: `You've reached your file upload limit. Current: ${currentFilesCount}, Max: ${maxFiles}. Please upgrade your plan to continue.`,
            currentCount: currentFilesCount,
            maxCount: maxFiles,
            limitType: 'files',
          });
        }

        const uploadedFiles = [];

        for (const file of files) {
          // Enhanced MIME type validation for security
          const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
            "application/pdf",
            "text/plain",
            "text/csv",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ];

          if (!file.mimetype || !allowedTypes.includes(file.mimetype)) {
            return res.status(400).json({
              success: false,
              error: `File type ${file.mimetype} is not supported. Please upload images, PDFs, Word documents, Excel files, PowerPoint presentations, or text files.`,
            });
          }

          // Additional security checks
          if (
            file.mimetype.includes("script") ||
            file.mimetype.includes("executable") ||
            file.originalname.includes("../") ||
            file.originalname.includes("..\\")
          ) {
            return res.status(400).json({
              success: false,
              error: "File contains potentially dangerous content",
            });
          }

          // Generate relative storage path
          const timestamp = Date.now();
          const sanitizedFilename = file.originalname.replace(
            /[^a-zA-Z0-9._-]/g,
            "_",
          );
          const relativeStoragePath = `users/${userId}/${timestamp}_${sanitizedFilename}`;

          // Upload file to Supabase Storage
          const { SupabaseStorageService } = await import("./supabaseService");
          const supabaseStorage = new SupabaseStorageService();
          
          await supabaseStorage.uploadFile(
            relativeStoragePath,
            file.buffer,
            file.mimetype
          );

          const fileRecord = await storage.createFile({
            userId,
            filename: file.originalname,
            fileSize: file.size,
            fileType: file.mimetype,
            storagePath: relativeStoragePath, // Store relative path instead of absolute
          });

          // Trigger background file processing for RAG if file type is supported
          if (fileProcessor.isFileTypeSupported(file.mimetype)) {
            // Process asynchronously - don't wait for completion
            fileProcessor
              .processFile(
                fileRecord.id,
                userId,
                relativeStoragePath, // Use relative path instead of full path
                file.mimetype,
              )
              .catch((error) => {
                console.error(
                  `Background processing failed for file ${fileRecord.id}:`,
                  error,
                );
                // Log error but don't fail the upload
              });

            console.log(
              `Initiated background processing for ${fileRecord.filename} (${file.mimetype})`,
            );
          } else {
            console.log(
              `File type ${file.mimetype} not supported for text extraction - skipping RAG processing`,
            );
          }

          uploadedFiles.push({
            ...fileRecord,
            url: `/api/files/${fileRecord.id}/download`, // Secure download URL
          });
        }

        // Increment file count and storage usage for each uploaded file
        for (const uploadedFile of uploadedFiles) {
          await storage.incrementFileCount(userId, uploadedFile.fileSize);
        }

        res.json({
          success: true,
          data: uploadedFiles,
          message: `${uploadedFiles.length} file(s) uploaded successfully to secure storage`,
        });
      } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ success: false, error: "Upload failed" });
      }
    },
  );

  app.get("/api/files/:id/download", requireAuth, async (req: any, res) => {
    try {
      // Verify file ownership
      const file = await storage.getFile(req.params.id);
      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "File not found" });
      }

      if (file.userId !== req.userId) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      // Set appropriate headers for file serving
      res.set({
        "Content-Type": file.fileType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "private, max-age=3600",
        "X-Frame-Options": "SAMEORIGIN",
        "X-Content-Type-Options": "nosniff",
      });

      // Download from Supabase Storage
      const { SupabaseStorageService } = await import("./supabaseService");
      const supabaseStorage = new SupabaseStorageService();
      const fileBuffer = await supabaseStorage.downloadFile(file.storagePath);
      res.send(fileBuffer);
    } catch (error) {
      console.error("Download error:", error);
      res.status(500).json({ success: false, error: "Download failed" });
    }
  });

  // Chat messages endpoints for database persistence
  app.post("/api/chat/messages", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { role, content, files, timestamp } = req.body;

      // Create chat message in database 
      const chatMessage = await storage.addChatMessage({
        userId,
        role,
        content,
        files: files || null,
        timestamp: new Date(timestamp)
      });

      res.json({ success: true, data: chatMessage });
    } catch (error) {
      console.error("Save chat message error:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to save chat message" 
      });
    }
  });

  app.get("/api/chat/messages", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const limit = parseInt(req.query.limit as string) || 50;
      
      // Get user's chat history from database
      const messages = await storage.getChatMessages(userId, limit);
      
      res.json({ success: true, data: messages });
    } catch (error) {
      console.error("Get chat messages error:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to retrieve chat messages" 
      });
    }
  });

  app.delete("/api/chat/messages", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      
      console.log(`[CHAT CLEAR] Clearing chat history for user: ${userId}`);
      
      // Get current messages count before clearing
      const messagesBefore = await storage.getChatMessages(userId);
      console.log(`[CHAT CLEAR] Messages before clear: ${messagesBefore.length}`);
      
      // Clear all chat history for the user
      await storage.clearChatHistory(userId);
      
      // Verify messages were cleared
      const messagesAfter = await storage.getChatMessages(userId);
      console.log(`[CHAT CLEAR] Messages after clear: ${messagesAfter.length}`);
      
      res.json({ 
        success: true, 
        message: "Chat history cleared successfully" 
      });
    } catch (error) {
      console.error("Clear chat history error:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to clear chat history" 
      });
    }
  });

  // File preview endpoint for images and inline viewing
  app.get("/api/files/:id/preview", requireAuth, async (req: any, res) => {
    try {
      // Verify file ownership
      const file = await storage.getFile(req.params.id);
      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "File not found" });
      }

      if (file.userId !== req.userId) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      // Set appropriate headers for inline viewing/preview
      res.set({
        "Content-Type": file.fileType,
        "Content-Disposition": `inline; filename="${file.filename}"`,
        "Cache-Control": "private, max-age=3600",
        "X-Frame-Options": "SAMEORIGIN",
        "X-Content-Type-Options": "nosniff",
      });

      // Download from Supabase Storage
      const { SupabaseStorageService } = await import("./supabaseService");
      const supabaseStorage = new SupabaseStorageService();
      const fileBuffer = await supabaseStorage.downloadFile(file.storagePath);
      res.send(fileBuffer);
    } catch (error) {
      console.error("Preview error:", error);
      res.status(500).json({ success: false, error: "Preview failed" });
    }
  });

  app.delete("/api/files/:id", requireAuth, async (req: any, res) => {
    try {
      // Verify file ownership
      const file = await storage.getFile(req.params.id);
      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "File not found" });
      }

      if (file.userId !== req.userId) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      // Clean up text chunks and processing data if file was processed for RAG
      try {
        await fileProcessor.removeFileProcessing(req.params.id);
        console.log(`Cleaned up RAG processing data for file ${req.params.id}`);
      } catch (cleanupError) {
        // Log error but don't fail the delete operation
        console.warn(
          `Failed to clean up RAG data for file ${req.params.id}:`,
          cleanupError,
        );
      }

      await storage.deleteFile(req.params.id);
      
      // Decrement files count and storage usage in subscription_usage
      await storage.decrementFileCount(req.userId, file.fileSize);
      
      res.json({ success: true, message: "File deleted" });
    } catch (error) {
      console.error("Delete error:", error);
      res.status(500).json({ success: false, error: "Delete failed" });
    }
  });

  // File processing status endpoint
  app.get(
    "/api/files/:id/processing-status",
    requireAuth,
    async (req: any, res) => {
      try {
        const fileId = req.params.id;
        const userId = req.userId;

        // Verify file ownership
        const file = await storage.getFile(fileId);
        if (!file) {
          return res
            .status(404)
            .json({ success: false, error: "File not found" });
        }

        if (file.userId !== userId) {
          return res
            .status(403)
            .json({ success: false, error: "Access denied" });
        }

        // Get processing status
        const processingStatus = fileProcessor.getProcessingStatus(fileId);

        // Also include file metadata about processing
        const response = {
          fileId,
          filename: file.filename,
          fileType: file.fileType,
          embeddingStatus: file.embeddingStatus || "pending",
          // Note: embeddingMetadata and textExtractionMetadata removed in Supabase schema
          processingStatus: processingStatus || {
            status:
              file.embeddingStatus === "completed" ? "completed" : "pending",
            stage:
              file.embeddingStatus === "completed" ? "complete" : "pending",
            progress: file.embeddingStatus === "completed" ? 100 : 0,
          },
        };

        res.json({ success: true, data: response });
      } catch (error) {
        console.error("Processing status fetch error:", error);
        res.status(500).json({ success: false, error: "Server error" });
      }
    },
  );

  // Job routes (protected)
  app.get("/api/jobs", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId; // From auth middleware, secure
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const jobs = await storage.getJobsByUserId(userId, limit, offset);
      res.json({ success: true, data: jobs });
    } catch (error) {
      console.error("Jobs fetch error:", error);
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  app.get("/api/jobs/:id", requireAuth, async (req: any, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: "Job not found" });
      }

      // Verify job ownership
      if (job.userId !== req.userId) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      res.json({ success: true, data: job });
    } catch (error) {
      console.error("Job fetch error:", error);
      res.status(500).json({ success: false, error: "Server error" });
    }
  });

  // Payment routes (Stripe integration)
  if (stripe) {
    app.post("/api/create-payment-intent", async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).json({ success: false, error: "Stripe not configured" });
        }
        const { amount } = req.body;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: "usd",
        });
        res.json({ success: true, clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: "Payment intent creation failed" });
      }
    });

    app.post("/api/get-or-create-subscription", async (req, res) => {
      try {
        const { userId } = req.body;

        if (!userId) {
          return res
            .status(400)
            .json({ success: false, error: "userId is required" });
        }

        // This is a simplified version - in a real app you'd handle subscription creation
        res.json({
          success: true,
          subscriptionId: "sub_placeholder",
          clientSecret: "pi_placeholder_client_secret",
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: "Subscription creation failed" });
      }
    });
  }

  // AI routes (OpenAI integration)
  if (openai) {
    // Analyze file content
    app.post("/api/ai/analyze-file", requireAuth, async (req: any, res) => {
      try {
        const { fileId, analysisType } = req.body;
        const userId = req.userId;

        if (!fileId) {
          return res
            .status(400)
            .json({ success: false, error: "fileId is required" });
        }

        // Get file from storage
        const file = await storage.getFile(fileId);
        if (!file) {
          return res
            .status(404)
            .json({ success: false, error: "File not found" });
        }

        // Verify ownership
        if (file.userId !== userId) {
          return res
            .status(403)
            .json({ success: false, error: "Access denied" });
        }

        // Extract text based on file type
        let textContent = "";
        if (file.fileType.startsWith("text/")) {
          textContent = `Text file content: ${file.filename}. This is a ${file.fileType} file that may contain documents, code, or written content.`;
        } else if (file.fileType === "application/pdf") {
          textContent = `PDF document: ${file.filename}. This is a PDF document that likely contains formatted text, reports, or documentation.`;
        } else if (file.fileType.startsWith("image/")) {
          textContent = `Image file: ${file.filename}. This is an image file (${file.fileType}) that may contain visual elements, photographs, graphics, or diagrams.`;
        } else if (file.fileType.startsWith("audio/")) {
          textContent = `Audio file: ${file.filename}. This is an audio file (${file.fileType}) that may contain music, speech, sounds, or recordings.`;
        } else if (file.fileType.startsWith("video/")) {
          textContent = `Video file: ${file.filename}. This is a video file (${file.fileType}) that contains moving images and possibly audio content.`;
        } else {
          textContent = `File: ${file.filename} (${file.fileType}). This file contains structured data or media content.`;
        }

        // Perform AI analysis
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are an AI file analysis system. Analyze the following file information and provide a comprehensive analysis. Return JSON with:
                - summary: Detailed summary of the file content and purpose (2-3 sentences)
                - sentiment: { rating: number (1-5 scale where 1=very negative, 5=very positive), confidence: number (0-1) }
                - tags: Array of relevant keywords/tags (5-8 items)
                - category: Main category (document, image, audio, video, data, code, etc.)
                - insights: Array of 2-3 key insights or notable characteristics
                - content_type: Specific content classification (report, photo, music, presentation, etc.)
                
                Provide professional, detailed analysis suitable for a business file management system.`,
            },
            {
              role: "user",
              content: textContent,
            },
          ],
          response_format: { type: "json_object" },
        });

        const analysis = JSON.parse(
          response.choices[0].message.content || "{}",
        );

        // Update file with AI analysis
        // Note: aiProcessed field removed in Supabase schema

        // Create analysis job record
        const job = await storage.createJob({
          userId,
          jobType: "ai_analysis",
          status: "completed",
          data: {
            fileId,
            result: analysis,
          },
        });

        res.json({ success: true, data: { jobId: job.id, analysis } });
      } catch (error) {
        console.error("AI file analysis failed:", error);
        res.status(500).json({ success: false, error: "AI analysis failed" });
      }
    });

    // Get analysis results
    app.get("/api/ai/analysis/:jobId", requireAuth, async (req: any, res) => {
      try {
        const jobId = req.params.jobId;
        const userId = req.userId;

        const job = await storage.getJob(jobId);
        if (!job) {
          return res
            .status(404)
            .json({ success: false, error: "Analysis job not found" });
        }

        // Verify ownership
        if (job.userId !== userId) {
          return res
            .status(403)
            .json({ success: false, error: "Access denied" });
        }

        res.json({ success: true, data: job });
      } catch (error) {
        console.error("Get analysis failed:", error);
        res
          .status(500)
          .json({ success: false, error: "Failed to get analysis" });
      }
    });

    // Direct text analysis (legacy endpoint)
    app.post("/api/ai/analyze", async (req, res) => {
      try {
        const { text, type } = req.body;

        if (!text || !type) {
          return res
            .status(400)
            .json({ success: false, error: "text and type are required" });
        }

        // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
        const response = await openai.chat.completions.create({
          model: "gpt-5",
          messages: [
            {
              role: "system",
              content:
                "Analyze the text and return JSON with summary, sentiment (rating 1-5, confidence 0-1), tags array, and category.",
            },
            {
              role: "user",
              content: text,
            },
          ],
          response_format: { type: "json_object" },
        });

        const analysis = JSON.parse(
          response.choices[0].message.content || "{}",
        );
        res.json({ success: true, data: analysis });
      } catch (error) {
        res.status(500).json({ success: false, error: "AI analysis failed" });
      }
    });

    app.post("/api/ai/generate-image", async (req, res) => {
      try {
        const { prompt } = req.body;

        if (!prompt) {
          return res
            .status(400)
            .json({ success: false, error: "prompt is required" });
        }

        const response = await openai.images.generate({
          model: "dall-e-3",
          prompt,
          n: 1,
          size: "1024x1024",
          quality: "standard",
        });

        res.json({ success: true, data: { url: response.data?.[0]?.url } });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: "Image generation failed" });
      }
    });
  }

  // Maintenance endpoint to reprocess pending files
  app.post(
    "/api/maintenance/reprocess-pending",
    requireAuth,
    async (req: any, res) => {
      try {
        const userId = req.userId;

        // Get all files for this user and filter for pending or failed ones
        const allFiles = await storage.getFilesByUserId(userId);
        const filesToProcess = allFiles.filter(
          (file) =>
            file.embeddingStatus === "pending" ||
            file.embeddingStatus === "failed",
        );

        if (filesToProcess.length === 0) {
          return res.json({
            success: true,
            message: "No pending or failed files to process",
            processedCount: 0,
          });
        }

        console.log(
          `Starting reprocessing for ${filesToProcess.length} pending/failed files for user ${userId}`,
        );

        // Process each pending/failed file
        let processedCount = 0;
        for (const file of filesToProcess) {
          try {
            console.log(`Reprocessing file: ${file.filename} (${file.id})`);

            // Trigger background processing
            fileProcessor
              .processFile(file.id, userId, file.storagePath, file.fileType)
              .catch((error) => {
                console.error(`Failed to reprocess file ${file.id}:`, error);
              });

            processedCount++;
          } catch (error) {
            console.error(
              `Error triggering reprocess for file ${file.id}:`,
              error,
            );
          }
        }

        res.json({
          success: true,
          message: `Started reprocessing ${processedCount} files`,
          processedCount,
        });
      } catch (error) {
        console.error("Maintenance reprocess failed:", error);
        res.status(500).json({
          success: false,
          error: "Failed to reprocess pending files",
        });
      }
    },
  );

  // Supabase RAG System - POST /api/upload endpoint
  app.post("/api/upload", requireAuth, upload.single("file"), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const userId = req.userId;
      
      // Check file upload limit
      const subscription = await storage.getUserSubscriptionWithLimits(userId);
      if (!subscription) {
        return res.status(403).json({ 
          success: false, 
          error: "No active subscription found" 
        });
      }
      
      // Enforce file limit
      if (subscription.maxFiles !== -1 && (subscription.usage?.filesCount ?? 0) >= subscription.maxFiles) {
        return res.status(403).json({ 
          success: false, 
          error: `File upload limit reached (${subscription.maxFiles} files)` 
        });
      }

      const file = req.file;
      const filename = file.originalname;
      const fileSize = file.size;
      const fileType = file.mimetype;

      // Generate storage path for Supabase Storage
      const timestamp = Date.now();
      const storagePath = `users/${userId}/${timestamp}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      // Upload to Supabase Storage
      const { SupabaseStorageService } = await import("./supabaseService");
      const supabaseStorage = new SupabaseStorageService();
      
      await supabaseStorage.uploadFile(
        storagePath,
        file.buffer,
        fileType
      );
      
      const uploadedPath = storagePath; // Store relative path
      const downloadUrl = null; // We'll use preview endpoint for downloads

      // Create document record in Supabase database
      const document = await storage.createFile({
        userId,
        filename,
        fileSize,
        fileType,
        storagePath: uploadedPath,
        downloadUrl,
        embeddingStatus: "pending",
      });
      
      // Increment file count and storage usage after successful upload
      await storage.incrementFileCount(userId, fileSize);

      // Start background processing for text extraction and embeddings
      if (fileProcessor.isFileTypeSupported(fileType)) {
        // Trigger background file processing for RAG using new extraction pipeline
        fileProcessor
          .processFile(
            document.id,
            userId,
            uploadedPath,
            fileType,
          )
          .catch(async (error) => {
            console.error(`Failed to process document ${document.id}:`, error);
            // Update file status to failed if processing errors occur after response is sent
            try {
              await storage.updateFile(document.id, { embeddingStatus: 'failed' });
            } catch (updateError) {
              console.error(`Failed to update file status for ${document.id}:`, updateError);
            }
          });
      }

      res.json({
        success: true,
        document: {
          id: document.id,
          filename: document.filename,
          fileType: document.fileType,
          fileSize: document.fileSize,
          downloadUrl: document.downloadUrl,
          embeddingStatus: document.embeddingStatus,
          createdAt: document.createdAt,
        },
      });
    } catch (error: any) {
      console.error("File upload failed:", error);
      res.status(500).json({
        error: "Upload failed: " + error.message,
      });
    }
  });

  // Supabase RAG System - GET /api/documents endpoint
  app.get("/api/documents", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;

      const documents = await storage.getFilesByUserId(userId, 50, 0);

      res.json({
        success: true,
        documents: documents.map((doc) => ({
          id: doc.id,
          filename: doc.filename,
          fileType: doc.fileType,
          fileSize: doc.fileSize,
          downloadUrl: doc.downloadUrl,
          embeddingStatus: doc.embeddingStatus,
          isShared: doc.isShared,
          createdAt: doc.createdAt,
        })),
      });
    } catch (error: any) {
      console.error("Failed to fetch documents:", error);
      res.status(500).json({
        error: "Failed to fetch documents: " + error.message,
      });
    }
  });

  // Supabase RAG System - POST /api/query (Core RAG Endpoint)
  app.post("/api/query", async (req, res) => {
    try {
      const { query } = req.body;

      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Query is required" });
      }

      // Get user from token (for now use placeholder)
      const userId =
        req.headers.authorization?.replace("Bearer ", "") ||
        "placeholder-user-id";

      if (!openai) {
        return res.status(500).json({ error: "OpenAI API not configured" });
      }

      // Step 1: Convert query into embedding vector using OpenAI text-embedding-ada-002
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: query,
      });

      const queryEmbedding = embeddingResponse.data[0].embedding;

      // Step 2: Perform vector similarity search in text_chunks table for semantic content retrieval
      const textChunks = await storage.searchSimilarTextChunks(
        userId,
        queryEmbedding,
        10,
      );

      if (textChunks.length === 0) {
        return res.json({
          response:
            "I don't have any processed document content to search through. Please upload and process some documents first.",
          sources: [],
          ragEnabled: true,
        });
      }

      // Step 3: Get the associated documents for source references
      const fileIds = Array.from(
        new Set(textChunks.map((chunk) => chunk.fileId)),
      );
      const sourceDocuments = await Promise.all(
        fileIds.map((fileId) => storage.getFile(fileId)),
      );
      const validSourceDocs = sourceDocuments.filter(
        (doc) => doc !== undefined,
      );

      // Step 4: Prepare context from retrieved text chunks
      const context = textChunks
        .map((chunk, index) => {
          const sourceDoc = validSourceDocs.find(
            (doc) => doc?.id === chunk.fileId,
          );
          const filename = sourceDoc?.filename || `Document ${chunk.fileId}`;
          return `[Chunk ${index + 1} from ${filename}]:\n${chunk.content}`;
        })
        .join("\n\n");

      // Step 5: Feed query and context to GPT-5 to generate response
      const chatResponse = await openai.chat.completions.create({
        model: "gpt-5", // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
        messages: [
          {
            role: "system",
            content:
              "You are a helpful AI assistant that answers questions based on the provided document context. Use only the information from the documents to answer questions. If the information is not in the documents, say so clearly. Cite the specific documents you reference.",
          },
          {
            role: "user",
            content: `Context from documents:\n${context}\n\nQuestion: ${query}`,
          },
        ],
      });

      const aiResponse = chatResponse.choices[0].message.content;

      // Step 6: Return response with source documents
      res.json({
        response: aiResponse,
        sources: validSourceDocs.map((doc) => ({
          id: doc!.id,
          filename: doc!.filename,
          fileType: doc!.fileType,
          downloadUrl: doc!.downloadUrl,
        })),
        ragEnabled: true,
        chunksFound: textChunks.length,
      });
    } catch (error: any) {
      console.error("RAG query failed:", error);
      res.status(500).json({
        error: "Query failed: " + error.message,
        ragEnabled: true,
      });
    }
  });

  // Supabase RAG System - POST /api/create-share-link endpoint
  app.post("/api/create-share-link", async (req, res) => {
    try {
      const { documentId } = req.body;

      if (!documentId) {
        return res.status(400).json({ error: "Document ID is required" });
      }

      // Get user from token (for now use placeholder)
      const userId =
        req.headers.authorization?.replace("Bearer ", "") ||
        "placeholder-user-id";

      // Verify document exists and belongs to user
      const document = await storage.getFile(documentId);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (document.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // Generate share link
      const shareToken = await storage.createShareLink(documentId);
      const shareUrl = `${req.protocol}://${req.get("host")}/shared/${shareToken}`;

      res.json({
        success: true,
        shareUrl,
        shareToken,
      });
    } catch (error: any) {
      console.error("Share link creation failed:", error);
      res.status(500).json({
        error: "Failed to create share link: " + error.message,
      });
    }
  });

  // Debug endpoint to list all Stripe prices
  app.get("/api/debug/stripe-prices", requireAuth, async (req: any, res) => {
    try {
      if (!stripe) {
        return res.status(500).json({ error: "Stripe not configured" });
      }

      const prices = await stripe.prices.list({ limit: 100 });
      const products = await stripe.products.list({ limit: 100 });

      const priceData = prices.data.map(p => ({
        id: p.id,
        product: p.product,
        amount: p.unit_amount,
        currency: p.currency,
        interval: p.recurring?.interval,
        active: p.active
      }));

      const productData = products.data.map(p => ({
        id: p.id,
        name: p.name,
        active: p.active
      }));

      console.log("[Debug] Stripe Prices:", JSON.stringify(priceData, null, 2));
      console.log("[Debug] Stripe Products:", JSON.stringify(productData, null, 2));

      res.json({
        success: true,
        prices: priceData,
        products: productData
      });
    } catch (error: any) {
      console.error("[Debug] Failed to list Stripe prices:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Stripe Payment Integration - POST /api/create-checkout-session
  app.post("/api/create-checkout-session", requireAuth, async (req: any, res) => {
    try {
      if (!stripe) {
        console.error("[Checkout] Stripe not configured");
        return res.status(500).json({ error: "Stripe not configured" });
      }

      const userId = req.userId;
      const user = req.user;
      const { priceId, planName, platform } = req.body;

      console.log("[Checkout] Request received:", { userId, priceId, planName, platform, userEmail: user.email });

      if (!priceId || !planName) {
        console.error("[Checkout] Missing priceId or planName");
        return res.status(400).json({ error: "Price ID and plan name are required" });
      }

      // Determine success and cancel URLs based on platform
      let successUrl: string;
      let cancelUrl: string;

      if (platform === 'mobile') {
        // Mobile app deep link URLs
        successUrl = `zorliapp://payment/success?session_id={CHECKOUT_SESSION_ID}`;
        cancelUrl = `zorliapp://payment/cancel`;
      } else {
        // Web app URLs
        successUrl = `${req.protocol}://${req.get("host")}/success?session_id={CHECKOUT_SESSION_ID}`;
        cancelUrl = `${req.protocol}://${req.get("host")}/upgrade`;
      }

      console.log("[Checkout] Using URLs:", { successUrl, cancelUrl });
      console.log("[Checkout] Stripe instance config:", {
        hasStripe: !!stripe,
        stripeConstructorName: stripe?.constructor?.name,
        // @ts-ignore - accessing private property for debugging
        apiVersion: stripe?._api?.apiVersion || 'unknown'
      });

      // Create checkout session for subscription with userId tracking
      // Stripe will automatically validate the price during session creation
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: user.email,
        client_reference_id: userId,
        metadata: {
          userId: userId,
          planName: planName,
          platform: platform || 'web',
        },
        subscription_data: {
          metadata: {
            userId: userId,
            planName: planName,
          },
        },
      });

      console.log("[Checkout] Session created successfully:", { sessionId: session.id, url: session.url });

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          url: session.url,
        },
      });
    } catch (error: any) {
      console.error("[Checkout] Session creation failed:", error.message, error.stack);
      res.status(500).json({
        error: "Failed to create checkout session: " + error.message,
      });
    }
  });

  // Stripe Webhook - POST /stripe-webhook  
  app.post(
    "/stripe-webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      console.log('[Webhook] ==================== WEBHOOK CALLED ====================');
      console.log('[Webhook] Headers:', JSON.stringify(req.headers, null, 2));
      
      try {
        if (!stripe) {
          console.error('[Webhook] ❌ Stripe not configured');
          return res.status(500).json({ error: "Stripe not configured" });
        }

        const sig = req.headers["stripe-signature"];
        const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

        console.log('[Webhook] Signature present:', !!sig);
        console.log('[Webhook] Endpoint secret configured:', !!endpointSecret);

        if (!sig) {
          console.error('[Webhook] ❌ Missing Stripe signature header');
          return res.status(400).json({ error: "Missing Stripe signature" });
        }
        
        if (!endpointSecret) {
          console.error('[Webhook] ❌ STRIPE_WEBHOOK_SECRET environment variable is not set!');
          console.error('[Webhook] ℹ️  Please add STRIPE_WEBHOOK_SECRET to your Replit Secrets');
          return res.status(400).json({ error: "Webhook secret not configured on server" });
        }

        let event;
        try {
          event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        } catch (err: any) {
          console.error("[Webhook] ❌ Signature verification failed:", err.message);
          return res.status(400).json({ error: "Webhook signature verification failed" });
        }

        console.log(`[Webhook] ✅ Event verified: ${event.type}`);

        // Handle the event
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as any;
            console.log("[Webhook] Processing checkout.session.completed");
            console.log("[Webhook] Session data:", JSON.stringify({
              customer_email: session.customer_email,
              client_reference_id: session.client_reference_id,
              metadata: session.metadata,
              customer: session.customer,
              subscription: session.subscription
            }, null, 2));
            
            try {
              // Import required modules
              const { db } = await import('./db');
              const { subscriptionPlans, userSubscriptions, subscriptionUsage, payments, users } = await import('@shared/schema');
              const { eq } = await import('drizzle-orm');
              
              // Extract data from session
              let userId = session.metadata?.userId || session.client_reference_id;
              const stripeSubscriptionId = session.subscription as string;
              const stripeCustomerId = session.customer as string;
              
              // If no userId, try to find user by email
              if (!userId) {
                console.error('[Webhook] No userId found in session');
                
                // Get email from session or fetch from Stripe Customer
                let customerEmail = session.customer_email;
                
                if (!customerEmail && stripeCustomerId) {
                  console.log('[Webhook] Fetching customer email from Stripe Customer:', stripeCustomerId);
                  try {
                    const customer = await stripe.customers.retrieve(stripeCustomerId);
                    customerEmail = (customer as any).email;
                    console.log('[Webhook] Retrieved email from Stripe Customer:', customerEmail);
                  } catch (err) {
                    console.error('[Webhook] Error fetching customer:', err);
                  }
                }
                
                if (customerEmail) {
                  console.log('[Webhook] Looking up user by email:', customerEmail);
                  const [user] = await db
                    .select()
                    .from(users)
                    .where(eq(users.email, customerEmail))
                    .limit(1);
                  
                  if (!user) {
                    console.error('[Webhook] ❌ No user found with email:', customerEmail);
                    break;
                  }
                  
                  console.log('[Webhook] ✅ Found user by email:', user.id);
                  userId = user.id;
                } else {
                  console.error('[Webhook] ❌ No email available to lookup user');
                  break;
                }
              }

              // Get subscription details from Stripe (with retry for race conditions)
              let subscription: Stripe.Subscription | undefined;
              let retries = 3;
              while (retries > 0) {
                try {
                  subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
                    expand: ['latest_invoice']
                  }) as Stripe.Subscription;
                  break;
                } catch (err: any) {
                  if (err.code === 'resource_missing' && retries > 1) {
                    console.log(`[Webhook] Subscription not ready yet, waiting 2s... (${retries} retries left)`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    retries--;
                  } else {
                    throw err;
                  }
                }
              }
              
              if (!subscription) {
                console.error('[Webhook] Failed to retrieve subscription after retries');
                break;
              }
              
              const stripePriceId = subscription.items.data[0]?.price.id;
              const amountInCents = (subscription.items.data[0]?.price as any).unit_amount || 0;
              const amount = Math.round(amountInCents / 100); // Convert cents to dollars
              
              console.log('[Webhook] Raw Stripe subscription billing period:', {
                current_period_start: (subscription as any).current_period_start,
                current_period_end: (subscription as any).current_period_end,
                current_period_start_type: typeof (subscription as any).current_period_start,
                current_period_end_type: typeof (subscription as any).current_period_end,
              });

              // 1. Find the subscription plan by stripe price ID
              const [plan] = await db
                .select()
                .from(subscriptionPlans)
                .where(eq(subscriptionPlans.stripePriceId, stripePriceId))
                .limit(1);

              if (!plan) {
                console.error(`[Webhook] No plan found for price ID: ${stripePriceId}`);
                break;
              }

              // 2. Update users table with Stripe IDs
              await db
                .update(users)
                .set({
                  stripeCustomerId,
                  stripeSubscriptionId,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, userId));

              // 3. Create/Update user_subscriptions record
              const [existingSubscription] = await db
                .select()
                .from(userSubscriptions)
                .where(eq(userSubscriptions.userId, userId))
                .limit(1);

              const subscriptionData = subscription as any;
              
              console.log('[Webhook] Full subscription object keys:', Object.keys(subscriptionData));
              console.log('[Webhook] Subscription period data:', {
                current_period_start: subscriptionData.current_period_start,
                current_period_end: subscriptionData.current_period_end,
                current_period_start_date: subscriptionData.current_period_start ? new Date(subscriptionData.current_period_start * 1000) : null,
                current_period_end_date: subscriptionData.current_period_end ? new Date(subscriptionData.current_period_end * 1000) : null,
              });
              
              // Validate and calculate billing period dates
              // Note: current_period_start and current_period_end are Unix timestamps (seconds)
              let currentPeriodStart: Date;
              let currentPeriodEnd: Date;
              
              if (subscriptionData.current_period_start && subscriptionData.current_period_end && 
                  subscriptionData.current_period_start !== subscriptionData.current_period_end) {
                // Use Stripe's billing period if both are present and different
                currentPeriodStart = new Date(subscriptionData.current_period_start * 1000);
                currentPeriodEnd = new Date(subscriptionData.current_period_end * 1000);
                console.log('[Webhook] ✅ Using Stripe billing period:', {
                  start: currentPeriodStart.toISOString(),
                  end: currentPeriodEnd.toISOString(),
                });
              } else {
                // Fallback: Calculate 30-day period from now
                console.warn('[Webhook] ⚠️ Missing or invalid billing period from Stripe, using fallback calculation:', {
                  current_period_start: subscriptionData.current_period_start,
                  current_period_end: subscriptionData.current_period_end,
                });
                currentPeriodStart = new Date();
                currentPeriodEnd = new Date(currentPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
                console.log('[Webhook] Using calculated billing period:', {
                  start: currentPeriodStart.toISOString(),
                  end: currentPeriodEnd.toISOString(),
                });
              }
              
              let userSubscriptionRecord;
              if (existingSubscription) {
                [userSubscriptionRecord] = await db
                  .update(userSubscriptions)
                  .set({
                    planId: plan.id,
                    stripeSubscriptionId,
                    stripeCustomerId,
                    status: subscription.status,
                    currentPeriodStart,
                    currentPeriodEnd,
                    trialStart: subscriptionData.trial_start ? new Date(subscriptionData.trial_start * 1000) : null,
                    trialEnd: subscriptionData.trial_end ? new Date(subscriptionData.trial_end * 1000) : null,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end,
                    updatedAt: new Date(),
                  })
                  .where(eq(userSubscriptions.id, existingSubscription.id))
                  .returning();
              } else {
                [userSubscriptionRecord] = await db
                  .insert(userSubscriptions)
                  .values({
                    userId,
                    planId: plan.id,
                    stripeSubscriptionId,
                    stripeCustomerId,
                    status: subscription.status,
                    currentPeriodStart,
                    currentPeriodEnd,
                    trialStart: subscriptionData.trial_start ? new Date(subscriptionData.trial_start * 1000) : null,
                    trialEnd: subscriptionData.trial_end ? new Date(subscriptionData.trial_end * 1000) : null,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end,
                  })
                  .returning();
              }

              // 4. Create/Update subscription_usage record
              const [existingUsage] = await db
                .select()
                .from(subscriptionUsage)
                .where(eq(subscriptionUsage.userId, userId))
                .limit(1);

              if (existingUsage) {
                await db
                  .update(subscriptionUsage)
                  .set({
                    subscriptionId: userSubscriptionRecord.id,
                    lastUpdated: new Date(),
                  })
                  .where(eq(subscriptionUsage.id, existingUsage.id));
              } else {
                await db
                  .insert(subscriptionUsage)
                  .values({
                    userId,
                    subscriptionId: userSubscriptionRecord.id,
                    filesCount: 0,
                    passwordsCount: 0,
                    aiPromptsCount: 0,
                    storageUsedBytes: 0,
                  });
              }

              // 5. Create payment record
              const invoiceId = typeof subscription.latest_invoice === 'string' 
                ? subscription.latest_invoice 
                : subscription.latest_invoice?.id;

              await db
                .insert(payments)
                .values({
                  paymentId: invoiceId || `${stripeSubscriptionId}_${Date.now()}`,
                  userId,
                  plan: plan.name,
                  amount,
                  currency: 'usd',
                  status: 'active',
                  subscriptionId: stripeSubscriptionId,
                  invoiceId,
                  periodStart: currentPeriodStart,
                  periodEnd: currentPeriodEnd,
                  metadata: {
                    sessionId: session.id,
                    planName: plan.displayName,
                  },
                });

              console.log(`[Webhook] ✅ All tables updated for user ${userId} - Plan: ${plan.name}`);
            } catch (error) {
              console.error('[Webhook] ❌ Error processing checkout:', error);
            }
            break;
          }

          case "invoice.paid": {
            const invoice = event.data.object as any;
            console.log("[Webhook] Processing invoice.paid:", invoice.id);
            console.log("[Webhook] Billing reason:", invoice.billing_reason);
            
            // Handle both initial subscription AND recurring payments
            if (invoice.billing_reason === 'subscription_create' || invoice.billing_reason === 'subscription_cycle') {
              try {
                // Extract subscription ID (could be string or object)
                const stripeSubscriptionId = typeof invoice.subscription === 'string' 
                  ? invoice.subscription 
                  : invoice.subscription?.id;
                
                if (!stripeSubscriptionId) {
                  console.error('[Webhook] ❌ No subscription ID found in invoice');
                  break;
                }
                
                const stripeCustomerId = invoice.customer as string;
                const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId) as any;
                let userId = subscription.metadata?.userId;
                
                // If no userId in metadata, look up by customer email (for Payment Links)
                if (!userId) {
                  console.log('[Webhook] No userId in metadata, looking up by customer email');
                  
                  let customerEmail = invoice.customer_email;
                  if (!customerEmail && stripeCustomerId) {
                    console.log('[Webhook] Fetching customer email from Stripe');
                    const customer = await stripe.customers.retrieve(stripeCustomerId);
                    customerEmail = (customer as any).email;
                  }
                  
                  if (customerEmail) {
                    const { db } = await import('./db');
                    const { users } = await import('@shared/schema');
                    const { eq } = await import('drizzle-orm');
                    
                    const [user] = await db
                      .select()
                      .from(users)
                      .where(eq(users.email, customerEmail))
                      .limit(1);
                    
                    if (user) {
                      console.log('[Webhook] ✅ Found user by email:', user.id);
                      userId = user.id;
                      
                      // Update user with Stripe IDs
                      await db
                        .update(users)
                        .set({
                          stripeCustomerId,
                          stripeSubscriptionId,
                          updatedAt: new Date(),
                        })
                        .where(eq(users.id, userId));
                      console.log('[Webhook] ✅ Updated users table with Stripe IDs');
                    } else {
                      console.log('[Webhook] ❌ No user found with email:', customerEmail);
                      break;
                    }
                  } else {
                    console.log('[Webhook] ❌ No email available');
                    break;
                  }
                }

                const { db } = await import('./db');
                const { payments } = await import('@shared/schema');
                const amountInCents = subscription.items.data[0]?.price.unit_amount || 0;
                const amount = Math.round(amountInCents / 100); // Convert cents to dollars

                // Get plan name from subscription
                const stripePriceId = subscription.items.data[0]?.price.id;
                const { subscriptionPlans } = await import('@shared/schema');
                const { eq } = await import('drizzle-orm');
                
                const [plan] = await db
                  .select()
                  .from(subscriptionPlans)
                  .where(eq(subscriptionPlans.stripePriceId, stripePriceId))
                  .limit(1);

                if (!plan) {
                  console.error('[Webhook] ❌ No plan found for price ID:', stripePriceId);
                  break;
                }

                // For initial subscriptions, update user_subscriptions and subscription_usage
                if (invoice.billing_reason === 'subscription_create') {
                  const { userSubscriptions, subscriptionUsage } = await import('@shared/schema');
                  
                  // Create/Update user_subscriptions
                  const [existingSubscription] = await db
                    .select()
                    .from(userSubscriptions)
                    .where(eq(userSubscriptions.userId, userId))
                    .limit(1);

                  let userSubscriptionRecord;
                  if (existingSubscription) {
                    [userSubscriptionRecord] = await db
                      .update(userSubscriptions)
                      .set({
                        planId: plan.id,
                        stripeSubscriptionId,
                        stripeCustomerId,
                        status: 'active',
                        currentPeriodStart: new Date(subscription.current_period_start * 1000),
                        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
                        updatedAt: new Date(),
                      })
                      .where(eq(userSubscriptions.id, existingSubscription.id))
                      .returning();
                    console.log('[Webhook] ✅ Updated user_subscriptions');
                  } else {
                    [userSubscriptionRecord] = await db
                      .insert(userSubscriptions)
                      .values({
                        userId,
                        planId: plan.id,
                        stripeSubscriptionId,
                        stripeCustomerId,
                        status: 'active',
                        currentPeriodStart: new Date(subscription.current_period_start * 1000),
                        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
                        createdAt: new Date(),
                        updatedAt: new Date(),
                      })
                      .returning();
                    console.log('[Webhook] ✅ Created user_subscriptions');
                  }

                  // Create/Update subscription_usage
                  const [existingUsage] = await db
                    .select()
                    .from(subscriptionUsage)
                    .where(eq(subscriptionUsage.userId, userId))
                    .limit(1);

                  if (existingUsage) {
                    await db
                      .update(subscriptionUsage)
                      .set({
                        subscriptionId: userSubscriptionRecord.id,
                        lastUpdated: new Date(),
                      })
                      .where(eq(subscriptionUsage.id, existingUsage.id));
                    console.log('[Webhook] ✅ Updated subscription_usage');
                  } else {
                    await db
                      .insert(subscriptionUsage)
                      .values({
                        userId,
                        subscriptionId: userSubscriptionRecord.id,
                        filesCount: 0,
                        passwordsCount: 0,
                        aiPromptsCount: 0,
                        storageUsedBytes: 0,
                        lastUpdated: new Date(),
                        createdAt: new Date(),
                      });
                    console.log('[Webhook] ✅ Created subscription_usage');
                  }
                }

                // Create payment record (for both initial and renewal)
                await db
                  .insert(payments)
                  .values({
                    paymentId: invoice.id,
                    userId,
                    plan: plan.name,
                    amount,
                    currency: 'usd',
                    status: 'active',
                    subscriptionId: stripeSubscriptionId,
                    invoiceId: invoice.id,
                    periodStart: new Date(subscription.current_period_start * 1000),
                    periodEnd: new Date(subscription.current_period_end * 1000),
                    metadata: { 
                      type: invoice.billing_reason === 'subscription_create' ? 'initial' : 'renewal' 
                    },
                  });

                console.log(`[Webhook] ✅ Payment recorded for user ${userId} (${invoice.billing_reason})`);
              } catch (error) {
                console.error('[Webhook] ❌ Error processing renewal:', error);
              }
            }
            break;
          }

          case "customer.subscription.deleted": {
            const subscription = event.data.object as any;
            console.log("[Webhook] Subscription canceled:", subscription.id);
            
            try {
              const { db } = await import('./db');
              const { userSubscriptions } = await import('@shared/schema');
              const { eq } = await import('drizzle-orm');

              // Update subscription status to canceled
              await db
                .update(userSubscriptions)
                .set({
                  status: 'canceled',
                  canceledAt: new Date(),
                  endedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(userSubscriptions.stripeSubscriptionId, subscription.id));

              console.log(`[Webhook] ✅ Subscription canceled in database`);
            } catch (error) {
              console.error('[Webhook] ❌ Error canceling subscription:', error);
            }
            break;
          }

          default:
            console.log(`[Webhook] Unhandled event type: ${event.type}`);
        }

        res.json({ received: true });
      } catch (error: any) {
        console.error("Webhook handling failed:", error);
        res.status(500).json({ error: "Webhook failed: " + error.message });
      }
    },
  );

  // Temporary migration endpoint to apply Supabase schema
  // ============================================
  // Subscription Management Routes
  // ============================================
  
  // Get current user's subscription status
  app.get("/api/subscription/status", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const userSubscription = await storage.getUserSubscription(userId);
      
      if (!userSubscription) {
        return res.json({
          hasSubscription: false,
          planName: 'free',
          status: 'active'
        });
      }
      
      res.json({
        hasSubscription: true,
        planName: userSubscription.planId,
        status: userSubscription.status,
        currentPeriodEnd: userSubscription.currentPeriodEnd,
        cancelAtPeriodEnd: userSubscription.cancelAtPeriodEnd
      });
    } catch (error: any) {
      console.error("Error getting subscription status:", error);
      res.status(500).json({ error: "Failed to get subscription status" });
    }
  });

  // Handle checkout success - sync subscription from Stripe
  app.post("/api/subscription/checkout-success", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ 
          error: "Session ID is required",
          type: "validation_error" 
        });
      }

      if (!subscriptionService.isConfigured()) {
        return res.status(500).json({ 
          error: "Stripe integration is not configured",
          type: "configuration_error" 
        });
      }

      // Get session from Stripe using subscriptionService
      let session;
      try {
        session = await subscriptionService.getCheckoutSession(sessionId);
      } catch (error: any) {
        console.error("Failed to retrieve checkout session:", error);
        return res.status(400).json({ 
          error: "Failed to retrieve checkout session from Stripe",
          message: error.message,
          type: "stripe_retrieval_error" 
        });
      }
      
      // Validate session has subscription data
      if (!session.subscription || !session.customer) {
        return res.status(400).json({ 
          error: "Invalid checkout session", 
          message: "Session does not contain subscription or customer information",
          type: "invalid_session_data" 
        });
      }

      // Webhook will handle the subscription sync automatically
      res.json({ 
        success: true, 
        message: "Subscription activated successfully. Your account will be updated shortly." 
      });
    } catch (error: any) {
      console.error("Error handling checkout success:", error);
      res.status(500).json({ 
        error: "Failed to process checkout completion",
        message: error.message,
        type: "unknown_error" 
      });
    }
  });

  // Get all available subscription plans
  const getPlansHandler = async (req: any, res: any) => {
    try {
      // Get plans directly from database with new schema
      const dbPlans = await storage.getAllSubscriptionPlans();
      
      // Format response with cleaned schema
      const plans = dbPlans.map(plan => ({
        id: plan.id,
        name: plan.name,
        displayName: plan.displayName,
        description: plan.description,
        priceMonthly: plan.priceMonthly, // In cents
        maxFiles: plan.maxFiles, // -1 for unlimited
        maxAIPrompts: plan.maxAIPrompts, // -1 for unlimited
        features: plan.features || [],
        stripePriceId: plan.stripePriceId,
      }));
      
      res.json({ data: plans });
    } catch (error: any) {
      console.error("Error getting subscription plans:", error);
      res.status(500).json({ error: "Failed to get subscription plans" });
    }
  };
  
  // Both endpoints for compatibility
  app.get("/api/subscription/plans", getPlansHandler);
  app.get("/api/subscription-plans", getPlansHandler);

  // Get current user's subscription with full details
  app.get("/api/subscriptions/current", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      
      // Get user subscription
      const userSubscription = await storage.getUserSubscription(userId);
      
      if (!userSubscription) {
        // Return free plan details
        return res.json({
          success: true,
          data: {
            plan: {
              name: 'free',
              displayName: 'Free',
              description: 'Intelligence for everyday tasks',
              priceMonthly: 0,
            },
            status: 'free'
          }
        });
      }
      
      // Get plan details
      const plan = await storage.getSubscriptionPlan(userSubscription.planId);
      
      res.json({
        success: true,
        data: {
          id: userSubscription.id,
          userId: userSubscription.userId,
          planId: userSubscription.planId,
          plan: {
            id: plan?.id,
            name: plan?.name || 'free',
            displayName: plan?.displayName || 'Free',
            description: plan?.description || '',
            priceMonthly: plan?.priceMonthly || 0,
            maxFiles: plan?.maxFiles || 10,
            maxAIPrompts: plan?.maxAIPrompts || 20,
            features: plan?.features || [],
          },
          status: userSubscription.status,
          currentPeriodStart: userSubscription.currentPeriodStart,
          currentPeriodEnd: userSubscription.currentPeriodEnd,
          cancelAtPeriodEnd: userSubscription.cancelAtPeriodEnd,
          stripeSubscriptionId: userSubscription.stripeSubscriptionId,
          stripeCustomerId: userSubscription.stripeCustomerId,
        }
      });
    } catch (error: any) {
      console.error("Error getting current subscription:", error);
      res.status(500).json({ success: false, error: "Failed to get subscription" });
    }
  });

  // Get user's subscription usage
  app.get("/api/subscriptions/usage", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const usage = await storage.getSubscriptionUsage(userId);
      const userSubscription = await storage.getUserSubscription(userId);
      const plan = userSubscription ? await storage.getSubscriptionPlan(userSubscription.planId) : null;
      
      // Get real-time storage calculation (same as dashboard metrics)
      const metrics = await storage.getDashboardMetrics(userId);
      
      res.json({
        success: true,
        data: {
          filesCount: usage?.filesCount || 0,
          passwordsCount: usage?.passwordsCount || 0,
          aiPromptsCount: usage?.aiPromptsCount || 0,
          storageUsedBytes: metrics.storageUsedBytes, // Use real-time calculation
          maxFiles: plan?.maxFiles || 10,
          maxAIPrompts: plan?.maxAIPrompts || 20,
        }
      });
    } catch (error: any) {
      console.error("Error getting subscription usage:", error);
      res.status(500).json({ success: false, error: "Failed to get usage data" });
    }
  });

  // Sync subscription data from Stripe
  app.post("/api/subscriptions/sync", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured() || !stripe) {
        return res.status(503).json({ error: "Stripe integration is not configured" });
      }

      const userId = req.userId;
      
      // Get current subscription
      const userSubscription = await storage.getUserSubscription(userId);
      if (!userSubscription || !userSubscription.stripeSubscriptionId) {
        return res.status(404).json({ error: "No active subscription found" });
      }

      // Fetch fresh subscription data from Stripe
      const subscription = await stripe.subscriptions.retrieve(userSubscription.stripeSubscriptionId);
      const subscriptionData = subscription as any;
      
      console.log('[Sync] Stripe subscription data:', {
        id: subscriptionData.id,
        status: subscriptionData.status,
        current_period_start: subscriptionData.current_period_start,
        current_period_end: subscriptionData.current_period_end,
        current_period_start_date: new Date(subscriptionData.current_period_start * 1000),
        current_period_end_date: new Date(subscriptionData.current_period_end * 1000),
      });

      // Update database with fresh data from Stripe
      await storage.updateUserSubscription(userSubscription.id, {
        status: subscriptionData.status,
        currentPeriodStart: new Date(subscriptionData.current_period_start * 1000),
        currentPeriodEnd: new Date(subscriptionData.current_period_end * 1000),
        cancelAtPeriodEnd: subscriptionData.cancel_at_period_end,
      });

      res.json({ 
        success: true, 
        message: "Subscription synced successfully",
        data: {
          currentPeriodStart: new Date(subscriptionData.current_period_start * 1000),
          currentPeriodEnd: new Date(subscriptionData.current_period_end * 1000),
        }
      });
    } catch (error: any) {
      console.error("Error syncing subscription:", error);
      res.status(500).json({ error: "Failed to sync subscription" });
    }
  });

  // Cancel subscription
  app.post("/api/subscriptions/cancel", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured()) {
        return res.status(503).json({ error: "Stripe integration is not configured" });
      }

      const userId = req.userId;
      
      // Get current subscription
      const userSubscription = await storage.getUserSubscription(userId);
      if (!userSubscription || !userSubscription.stripeSubscriptionId) {
        return res.status(404).json({ error: "No active subscription found" });
      }

      // Cancel subscription at period end in Stripe
      await subscriptionService.cancelSubscription(userSubscription.stripeSubscriptionId);

      // Update database
      await storage.updateUserSubscription(userSubscription.id, {
        cancelAtPeriodEnd: true,
      });

      res.json({ 
        success: true, 
        message: "Subscription will be canceled at the end of the billing period" 
      });
    } catch (error: any) {
      console.error("Error canceling subscription:", error);
      res.status(500).json({ error: "Failed to cancel subscription" });
    }
  });

  // Create a checkout session for subscription
  app.post("/api/subscription/checkout", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured()) {
        return res.status(503).json({ error: "Stripe integration is not configured. Please contact support." });
      }

      const userId = req.userId;
      const { planId } = req.body;

      if (!planId) {
        return res.status(400).json({ error: "Plan ID is required" });
      }

      // Get user details
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get plan details
      const plan = await storage.getSubscriptionPlan(planId);
      if (!plan || !plan.stripePriceId) {
        return res.status(404).json({ error: "Plan not found or not configured" });
      }

      // Create or get Stripe customer
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await subscriptionService.createCustomer(
          user.email || user.username,
          user.username,
          userId
        );
        customerId = customer.id;
        await storage.updateUserStripeInfo(userId, customerId);
      }

      // Create checkout session
      const successUrl = `${req.headers.origin || 'http://localhost:5000'}/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${req.headers.origin || 'http://localhost:5000'}/subscription`;

      const session = await subscriptionService.createCheckoutSession(
        customerId,
        plan.stripePriceId,
        successUrl,
        cancelUrl,
        userId, // Pass userId for metadata
        30 // Default 30-day trial
      );

      res.json({ sessionId: session.id, url: session.url });
    } catch (error: any) {
      console.error("Error creating checkout session:", error);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // Update subscription (upgrade/downgrade)
  app.post("/api/subscription/update", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured()) {
        return res.status(503).json({ error: "Stripe integration is not configured. Please contact support." });
      }

      const userId = req.userId;
      const { newPlanId } = req.body;

      if (!newPlanId) {
        return res.status(400).json({ error: "New plan ID is required" });
      }

      // Get current subscription
      const currentSubscription = await storage.getUserSubscription(userId);
      if (!currentSubscription || !currentSubscription.stripeSubscriptionId) {
        return res.status(404).json({ error: "No active subscription found" });
      }

      // Get new plan details
      const newPlan = await storage.getSubscriptionPlan(newPlanId);
      if (!newPlan || !newPlan.stripePriceId) {
        return res.status(404).json({ error: "Plan not found or not configured" });
      }

      // Update subscription in Stripe
      await subscriptionService.updateSubscription(
        currentSubscription.stripeSubscriptionId,
        newPlan.stripePriceId
      );

      // Webhook will handle the database sync automatically
      res.json({ success: true, message: "Subscription updated successfully. Your account will be updated shortly." });
    } catch (error: any) {
      console.error("Error updating subscription:", error);
      res.status(500).json({ error: "Failed to update subscription" });
    }
  });

  // Cancel subscription
  app.post("/api/subscription/cancel", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured()) {
        return res.status(503).json({ error: "Stripe integration is not configured. Please contact support." });
      }

      const userId = req.userId;
      const { immediate } = req.body; // Allow immediate cancellation

      // Get current subscription
      const currentSubscription = await storage.getUserSubscription(userId);
      if (!currentSubscription || !currentSubscription.stripeSubscriptionId) {
        return res.status(404).json({ error: "No active subscription found" });
      }

      // Cancel in Stripe (webhook will handle database sync)
      if (immediate) {
        await subscriptionService.cancelSubscriptionImmediately(currentSubscription.stripeSubscriptionId);
      } else {
        await subscriptionService.cancelSubscription(currentSubscription.stripeSubscriptionId);
      }

      res.json({ 
        success: true, 
        message: immediate 
          ? "Subscription canceled immediately" 
          : "Subscription will be canceled at the end of the billing period" 
      });
    } catch (error: any) {
      console.error("Error canceling subscription:", error);
      res.status(500).json({ error: "Failed to cancel subscription" });
    }
  });

  // Resume canceled subscription
  app.post("/api/subscription/resume", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured()) {
        return res.status(503).json({ error: "Stripe integration is not configured. Please contact support." });
      }

      const userId = req.userId;

      // Get current subscription
      const currentSubscription = await storage.getUserSubscription(userId);
      if (!currentSubscription || !currentSubscription.stripeSubscriptionId) {
        return res.status(404).json({ error: "No subscription found" });
      }

      // Resume in Stripe (webhook will handle database sync)
      await subscriptionService.resumeSubscription(currentSubscription.stripeSubscriptionId);

      res.json({ success: true, message: "Subscription resumed successfully. Your account will be updated shortly." });
    } catch (error: any) {
      console.error("Error resuming subscription:", error);
      res.status(500).json({ error: "Failed to resume subscription" });
    }
  });

  // Create customer portal session
  app.post("/api/subscription/portal", requireAuth, async (req: any, res) => {
    try {
      // Check if Stripe is configured
      if (!subscriptionService.isConfigured()) {
        return res.status(503).json({ error: "Stripe integration is not configured. Please contact support." });
      }

      const userId = req.userId;
      
      // Get user
      const user = await storage.getUser(userId);
      if (!user || !user.stripeCustomerId) {
        return res.status(404).json({ error: "No Stripe customer found" });
      }

      const returnUrl = `${req.headers.origin || 'http://localhost:5000'}/subscription`;
      const portalSession = await subscriptionService.createPortalSession(
        user.stripeCustomerId,
        returnUrl
      );

      res.json({ url: portalSession.url });
    } catch (error: any) {
      console.error("Error creating portal session:", error);
      res.status(500).json({ error: "Failed to create portal session" });
    }
  });

  // ============================================
  // Account Credentials (Password Vault) Routes
  // ============================================
  
  // Get all credentials for current user
  app.get("/api/credentials", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      const credentials = await storage.getAccountCredentialsByUserId(userId, limit, offset);
      
      // Decrypt passwords before sending
      const decryptedCredentials = credentials.map(cred => ({
        ...cred,
        encryptedPassword: undefined, // Remove encrypted password from response
        password: decryptPassword(cred.encryptedPassword),
      }));

      res.json({ success: true, data: decryptedCredentials });
    } catch (error: any) {
      console.error("Error getting credentials:", error);
      res.status(500).json({ error: "Failed to get credentials" });
    }
  });

  // Get single credential
  app.get("/api/credentials/:id", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;

      const credential = await storage.getAccountCredential(id);
      
      if (!credential) {
        return res.status(404).json({ error: "Credential not found" });
      }

      // Verify ownership
      if (credential.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // Decrypt password
      const decryptedCredential = {
        ...credential,
        encryptedPassword: undefined,
        password: decryptPassword(credential.encryptedPassword),
      };

      res.json(decryptedCredential);
    } catch (error: any) {
      console.error("Error getting credential:", error);
      res.status(500).json({ error: "Failed to get credential" });
    }
  });

  // Create new credential
  app.post("/api/credentials", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      
      // Encrypt the password before validation
      const bodyWithEncryptedPassword = {
        ...req.body,
        userId,
        encryptedPassword: req.body.password ? encryptPassword(req.body.password) : undefined,
      };
      
      // Remove the plain password field from validation
      delete bodyWithEncryptedPassword.password;
      
      // Validate request body
      const validation = insertAccountCredentialSchema.safeParse(bodyWithEncryptedPassword);

      if (!validation.success) {
        return res.status(400).json({ error: "Invalid credential data", details: validation.error });
      }

      const { serviceName, username, encryptedPassword, website, notes, passwordHint, category, isFavorite } = validation.data;

      // Create credential
      const credential = await storage.createAccountCredential({
        userId,
        serviceName,
        username,
        encryptedPassword,
        website: website || null,
        notes: notes || null,
        passwordHint: passwordHint || null,
        category: category || null,
        isFavorite: isFavorite || false,
      });

      // Increment password count
      await storage.incrementPasswordCount(userId);

      // Return credential with decrypted password (original plain password)
      res.json({
        ...credential,
        encryptedPassword: undefined,
        password: req.body.password,
      });
    } catch (error: any) {
      console.error("Error creating credential:", error);
      res.status(500).json({ error: "Failed to create credential" });
    }
  });

  // Update credential
  app.put("/api/credentials/:id", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;

      // Check if credential exists and belongs to user
      const existingCredential = await storage.getAccountCredential(id);
      if (!existingCredential) {
        return res.status(404).json({ error: "Credential not found" });
      }

      if (existingCredential.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // Prepare updates
      const updates: any = {};
      if (req.body.serviceName) updates.serviceName = req.body.serviceName;
      if (req.body.username !== undefined) updates.username = req.body.username;
      if (req.body.website !== undefined) updates.website = req.body.website;
      if (req.body.notes !== undefined) updates.notes = req.body.notes;
      if (req.body.passwordHint !== undefined) updates.passwordHint = req.body.passwordHint;
      if (req.body.category !== undefined) updates.category = req.body.category;
      if (req.body.isFavorite !== undefined) updates.isFavorite = req.body.isFavorite;
      
      // Encrypt password if provided
      if (req.body.password) {
        updates.encryptedPassword = encryptPassword(req.body.password);
      }

      // Update credential
      const updated = await storage.updateAccountCredential(id, updates);

      // Return without encrypted password
      res.json({
        ...updated,
        encryptedPassword: undefined,
        password: req.body.password ? req.body.password : decryptPassword(updated.encryptedPassword),
      });
    } catch (error: any) {
      console.error("Error updating credential:", error);
      res.status(500).json({ error: "Failed to update credential" });
    }
  });

  // Delete credential
  app.delete("/api/credentials/:id", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;

      // Check if credential exists and belongs to user
      const credential = await storage.getAccountCredential(id);
      if (!credential) {
        return res.status(404).json({ error: "Credential not found" });
      }

      if (credential.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // Delete credential
      await storage.deleteAccountCredential(id);

      // Decrement password count
      await storage.decrementPasswordCount(userId);

      res.json({ success: true, message: "Credential deleted successfully" });
    } catch (error: any) {
      console.error("Error deleting credential:", error);
      res.status(500).json({ error: "Failed to delete credential" });
    }
  });

  // Note: Stripe webhooks are now handled in server/index.ts before express.json() middleware
  // This ensures proper signature verification with raw body

  app.post("/api/admin/migrate", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");

      // Check if tables already exist
      const tableCheck = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('users', 'documents', 'jobs')
      `);

      if (tableCheck.length === 3) {
        return res.json({
          success: true,
          message: "Tables already exist",
          tables: tableCheck.map((r: any) => r.table_name),
        });
      }

      // Apply the migration SQL
      const migrationSQL = `
        CREATE TABLE IF NOT EXISTS "documents" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "user_id" varchar NOT NULL,
          "filename" text NOT NULL,
          "file_size" integer NOT NULL,
          "file_type" text NOT NULL,
          "storage_path" text NOT NULL,
          "download_url" text,
          "extracted_text" text,
          "embedding" json,
          "embedding_status" text DEFAULT 'pending',
          "share_token" text,
          "is_shared" boolean DEFAULT false,
          "created_at" timestamp DEFAULT now(),
          "updated_at" timestamp DEFAULT now(),
          CONSTRAINT "documents_share_token_unique" UNIQUE("share_token")
        );
        
        CREATE TABLE IF NOT EXISTS "jobs" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "user_id" varchar NOT NULL,
          "job_type" text NOT NULL,
          "status" text DEFAULT 'waiting' NOT NULL,
          "data" json NOT NULL,
          "result" json,
          "progress" integer DEFAULT 0,
          "error" text,
          "created_at" timestamp DEFAULT now(),
          "updated_at" timestamp DEFAULT now()
        );
        
        CREATE TABLE IF NOT EXISTS "users" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "email" text,
          "username" text NOT NULL,
          "password" text NOT NULL,
          "stripe_customer_id" text,
          "stripe_subscription_id" text,
          "created_at" timestamp DEFAULT now(),
          "updated_at" timestamp DEFAULT now(),
          CONSTRAINT "users_email_unique" UNIQUE("email"),
          CONSTRAINT "users_username_unique" UNIQUE("username")
        );
        
        -- Add foreign key constraints if they don't exist
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'documents_user_id_users_id_fk'
          ) THEN
            ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" 
            FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
          END IF;
          
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'jobs_user_id_users_id_fk'
          ) THEN
            ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" 
            FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
          END IF;
        END $$;
      `;

      // Execute the migration
      await db.execute(sql.raw(migrationSQL));

      // Verify tables were created
      const finalCheck = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('users', 'documents', 'jobs')
      `);

      res.json({
        success: true,
        message: "Migration applied successfully",
        tables: finalCheck.map((r: any) => r.table_name),
      });
    } catch (error: any) {
      console.error("Migration failed:", error);
      res.status(500).json({
        success: false,
        error: "Migration failed: " + error.message,
      });
    }
  });

  // Get signed URL for a storage path (authenticated)
  app.post("/api/storage/signed-url", requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const { storagePath } = req.body;

      if (!storagePath) {
        return res.status(400).json({ error: "Storage path is required" });
      }

      // Security: Verify user can only access their own files
      if (!storagePath.startsWith(`users/${userId}/`)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { SupabaseStorageService } = await import("./supabaseService");
      const supabaseStorage = new SupabaseStorageService();

      // Generate signed URL valid for 60 minutes
      const signedUrl = await supabaseStorage.getSignedUrl(storagePath, 3600);

      res.json({ 
        success: true, 
        data: { signedUrl } 
      });
    } catch (error: any) {
      console.error("Error generating signed URL:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to generate signed URL" 
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
