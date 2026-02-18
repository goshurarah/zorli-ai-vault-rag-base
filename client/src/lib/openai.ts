import OpenAI from 'openai'

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
const DEFAULT_MODEL = 'gpt-5'

export interface AIAnalysisResult {
  summary: string
  sentiment: {
    rating: number
    confidence: number
  }
  tags: string[]
  category: string
}

export interface ImageAnalysisResult {
  description: string
  objects: string[]
  scene: string
  text_content?: string
}

export class AIService {
  // Text analysis and summarization
  static async analyzeText(text: string): Promise<AIAnalysisResult> {
    try {
      const response = await openai.chat.completions.create({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'system',
            content: `Analyze the following text and return a JSON response with:
              - summary: A concise summary of the text
              - sentiment: { rating: number (1-5), confidence: number (0-1) }
              - tags: Array of relevant tags/keywords
              - category: Main category/topic
              
              Respond only with valid JSON.`
          },
          {
            role: 'user',
            content: text
          }
        ],
        response_format: { type: 'json_object' }
      })

      const result = JSON.parse(response.choices[0].message.content || '{}')
      return result as AIAnalysisResult
    } catch (error) {
      console.error('AI text analysis failed:', error)
      throw new Error('Failed to analyze text with AI')
    }
  }

  // Image analysis
  static async analyzeImage(base64Image: string): Promise<ImageAnalysisResult> {
    try {
      const response = await openai.chat.completions.create({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this image and return a JSON response with: description, objects (array), scene, and text_content (if any text is visible). Respond only with valid JSON.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 1024
      })

      const result = JSON.parse(response.choices[0].message.content || '{}')
      return result as ImageAnalysisResult
    } catch (error) {
      console.error('AI image analysis failed:', error)
      throw new Error('Failed to analyze image with AI')
    }
  }

  // Generate image from text prompt
  static async generateImage(prompt: string): Promise<{ url: string }> {
    try {
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard'
      })

      return { url: response.data?.[0]?.url || '' }
    } catch (error) {
      console.error('AI image generation failed:', error)
      throw new Error('Failed to generate image with AI')
    }
  }

  // Transcribe audio
  static async transcribeAudio(audioFile: File): Promise<{ text: string; duration?: number }> {
    try {
      const response = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1'
      })

      return {
        text: response.text,
        duration: undefined
      }
    } catch (error) {
      console.error('AI audio transcription failed:', error)
      throw new Error('Failed to transcribe audio with AI')
    }
  }
}

export { openai }