import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import * as fs from 'fs/promises'
import path from 'path'

// Initialize clients
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY! // Service role for server operations
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

export class SupabaseStorageService {
  private bucketName = 'documents'

  constructor() {
    this.ensureBucketExists()
  }

  private async ensureBucketExists() {
    try {
      const { data, error } = await supabase.storage.getBucket(this.bucketName)
      
      if (error && error.message.includes('not found')) {
        // Create bucket if it doesn't exist - allow all file types
        await supabase.storage.createBucket(this.bucketName, {
          public: false,
          fileSizeLimit: 52428800 // 50MB, no MIME type restrictions
        })
        console.log('Created storage bucket (all file types allowed)')
      }
    } catch (error) {
      console.error('Error ensuring bucket exists:', error)
    }
  }

  async uploadFile(filePath: string, fileBuffer: Buffer, contentType: string): Promise<string> {
    try {
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .upload(filePath, fileBuffer, {
          contentType,
          upsert: false
        })

      if (error) {
        throw new Error(`Supabase Storage upload failed: ${error.message}`)
      }

      return data.path
    } catch (error) {
      console.error('File upload error:', error)
      throw error
    }
  }

  async getSignedUrl(filePath: string, expiresIn: number = 3600): Promise<string> {
    try {
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .createSignedUrl(filePath, expiresIn)

      if (error) {
        throw new Error(`Failed to generate signed URL: ${error.message}`)
      }

      return data.signedUrl
    } catch (error) {
      console.error('Signed URL generation error:', error)
      throw error
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      const { error } = await supabase.storage
        .from(this.bucketName)
        .remove([filePath])

      if (error) {
        throw new Error(`Failed to delete file: ${error.message}`)
      }
    } catch (error) {
      console.error('File deletion error:', error)
      throw error
    }
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    try {
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .download(filePath)

      if (error) {
        throw new Error(`Failed to download file: ${error.message}`)
      }

      return Buffer.from(await data.arrayBuffer())
    } catch (error) {
      console.error('File download error:', error)
      throw error
    }
  }
}

export class EmbeddingService {
  static async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text.substring(0, 8191), // OpenAI embedding limit
      })

      return response.data[0].embedding
    } catch (error) {
      console.error('Embedding generation failed:', error)
      throw new Error('Failed to generate embedding')
    }
  }

  static async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: texts.map(text => text.substring(0, 8191)),
      })

      return response.data.map(item => item.embedding)
    } catch (error) {
      console.error('Batch embedding generation failed:', error)
      throw new Error('Failed to generate embeddings')
    }
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, ai, i) => sum + ai * b[i], 0)
    const magnitudeA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0))
    const magnitudeB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0))
    return dotProduct / (magnitudeA * magnitudeB)
  }
}

export class RAGService {
  static async generateRAGResponse(query: string, relevantDocs: any[]): Promise<string> {
    try {
      const context = relevantDocs
        .map(doc => `Document: ${doc.filename}\nContent: ${doc.textContent || 'No text content available'}`)
        .join('\n\n')

      const response = await openai.chat.completions.create({
        model: 'gpt-5', // Latest model as specified
        messages: [
          {
            role: 'system',
            content: `You are a helpful AI assistant that answers questions based on the provided document context. 
            
            Instructions:
            - Use only the information from the provided documents to answer the question
            - If the documents don't contain relevant information, say so clearly
            - Cite which documents you're referencing when possible
            - Provide detailed, accurate answers when the information is available
            - Be concise but comprehensive`
          },
          {
            role: 'user',
            content: `Context from documents:\n${context}\n\nQuestion: ${query}`
          }
        ],
        max_tokens: 2000,
        temperature: 0.3
      })

      return response.choices[0].message.content || 'I apologize, but I could not generate a response.'
    } catch (error) {
      console.error('RAG response generation failed:', error)
      throw new Error('Failed to generate RAG response')
    }
  }
}

export { supabase as supabaseServer }