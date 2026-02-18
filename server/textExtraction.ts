// Dynamic import for pdf-parse to avoid initialization issues
import mammoth from 'mammoth';
import { createWorker } from 'tesseract.js';
import { parse as parseHtml } from 'node-html-parser';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import XLSX from 'xlsx';
import { fromPath as pdf2pic } from 'pdf2pic';
import * as officeParser from 'officeparser';
import PptxParser from 'node-pptx-parser';
import pptx2json from 'pptx2json';

export interface ExtractedText {
  content: string;
  metadata?: {
    pages?: number;
    wordCount?: number;
    language?: string;
    extractionMethod?: string;
    confidence?: number;
    includesNotes?: boolean;
  };
}

export class TextExtractionService {
  private static instance: TextExtractionService;
  private ocrWorker: any = null;

  private constructor() {}

  public static getInstance(): TextExtractionService {
    if (!TextExtractionService.instance) {
      TextExtractionService.instance = new TextExtractionService();
    }
    return TextExtractionService.instance;
  }

  /**
   * Extract text from various file types
   */
  async extractText(filePath: string, mimeType: string): Promise<ExtractedText> {
    try {
      console.log(`Extracting text from file: ${path.basename(filePath)} (${mimeType})`);

      switch (mimeType) {
        case 'application/pdf':
          return await this.extractFromPDF(filePath);
        
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          return await this.extractFromDocx(filePath);
        
        case 'text/html':
          return await this.extractFromHTML(filePath);
        
        case 'text/plain':
        case 'application/json':
        case 'text/xml':
          return await this.extractFromText(filePath);
          
        case 'text/csv':
          return await this.extractFromCSV(filePath);
          
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.ms-excel':
          return await this.extractFromExcel(filePath);
          
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          return await this.extractFromPPTX(filePath);
        
        case 'image/jpeg':
        case 'image/png':
        case 'image/gif':
        case 'image/webp':
        case 'image/bmp':
        case 'image/tiff':
          return await this.extractFromImage(filePath);
        
        // Legacy Office format fallbacks
        case 'application/vnd.ms-powerpoint':
          return await this.extractFromPPTX(filePath); // May work for older .ppt files
          
        case 'application/vnd.ms-word':
          return await this.extractFromDocx(filePath); // May work for older .doc files
          
        case 'text/markdown':
          return await this.extractFromText(filePath);
          
        default:
          // Try to extract as text if unknown type
          if (mimeType.startsWith('text/')) {
            console.log(`Attempting text extraction fallback for MIME type: ${mimeType}`);
            return await this.extractFromText(filePath);
          }
          
          // For any other unknown type, attempt text extraction as last resort
          console.warn(`Unknown MIME type ${mimeType}, attempting text extraction fallback`);
          try {
            return await this.extractFromText(filePath);
          } catch (fallbackError) {
            throw new Error(`Unsupported file type: ${mimeType}. Text extraction fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`);
          }
      }
    } catch (error) {
      console.error(`Text extraction failed for ${filePath}:`, error);
      throw new Error(`Failed to extract text: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from PDF files using pdf2pic + OCR
   */
  private async extractFromPDF(filePath: string): Promise<ExtractedText> {
    try {
      // Check if file exists first
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      const dataBuffer = fs.readFileSync(filePath);
      console.log(`Processing PDF file: ${filePath}, buffer size: ${dataBuffer.length} bytes`);

      // Initialize OCR worker if not already done
      if (!this.ocrWorker) {
        console.log('Initializing OCR worker for PDF processing...');
        this.ocrWorker = await createWorker('eng');
      }

      // Configure PDF to image conversion
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const options = {
        density: 200,           // High DPI for better OCR
        saveFilename: `pdf_page`,
        savePath: tempDir,
        format: "png" as const,
        width: 1200,           // Good resolution for OCR
        height: 1600
      };

      // Convert PDF to images using pdf2pic
      const convertPdf = pdf2pic(filePath, options);
      console.log('Converting PDF pages to images for OCR...');
      
      let allText: string[] = [];
      let totalPages = 0;
      
      try {
        // Process up to 50 pages for complete document coverage (reasonable limit to prevent excessive resource use)
        const maxPages = 50; // Process up to 50 pages for complete document coverage
        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
          try {
            const result = await convertPdf(pageNum, { responseType: "image" });
            if (result && result.path) {
              totalPages++;
              console.log(`Processing page ${pageNum} with OCR...`);
              
              // Extract text from the converted image using OCR
              const { data: { text, confidence } } = await this.ocrWorker.recognize(result.path);
              
              if (text.trim()) {
                allText.push(`--- Page ${pageNum} ---\n${text.trim()}`);
                console.log(`Page ${pageNum} OCR completed, confidence: ${Math.round(confidence)}%`);
              }
              
              // Clean up the temporary image file
              try {
                fs.unlinkSync(result.path);
              } catch (cleanupError) {
                console.warn(`Failed to clean up temp image: ${result.path}`, cleanupError);
              }
            }
          } catch (pageError) {
            // If we can't process a page, it might mean we've reached the end of the PDF
            console.log(`Reached end of PDF or failed to process page ${pageNum}`);
            break;
          }
        }
        
        if (allText.length === 0) {
          throw new Error('No text could be extracted from any PDF pages');
        }
        
        const combinedText = allText.join('\n\n');
        console.log(`Successfully extracted text from ${totalPages} pages of PDF`);
        
        return {
          content: combinedText,
          metadata: {
            pages: totalPages,
            wordCount: combinedText.split(/\s+/).length,
            extractionMethod: 'pdf2pic-ocr',
            confidence: totalPages > 0 ? Math.round(85) : 0 // Approximate confidence
          }
        };
        
      } catch (conversionError) {
        console.error('PDF conversion/OCR failed:', conversionError);
        throw new Error(`PDF conversion failed: ${conversionError instanceof Error ? conversionError.message : 'Unknown conversion error'}`);
      }
      
    } catch (error) {
      console.error(`PDF extraction failed for ${filePath}:`, error);
      throw new Error(`PDF parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from Word documents (.docx)
   */
  private async extractFromDocx(filePath: string): Promise<ExtractedText> {
    const result = await mammoth.extractRawText({ path: filePath });
    
    return {
      content: result.value,
      metadata: {
        wordCount: result.value.split(/\s+/).length,
        extractionMethod: 'mammoth'
      }
    };
  }

  /**
   * Extract text from HTML files
   */
  private async extractFromHTML(filePath: string): Promise<ExtractedText> {
    const htmlContent = fs.readFileSync(filePath, 'utf-8');
    const root = parseHtml(htmlContent);
    
    // Remove script and style elements
    root.querySelectorAll('script, style').forEach(el => el.remove());
    
    const textContent = root.text;
    
    return {
      content: textContent,
      metadata: {
        wordCount: textContent.split(/\s+/).length,
        extractionMethod: 'html-parser'
      }
    };
  }

  /**
   * Extract text from plain text files
   */
  private async extractFromText(filePath: string): Promise<ExtractedText> {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    return {
      content,
      metadata: {
        wordCount: content.split(/\s+/).length,
        extractionMethod: 'direct-read'
      }
    };
  }

  /**
   * Extract text from images using OCR
   */
  private async extractFromImage(filePath: string): Promise<ExtractedText> {
    try {
      // Initialize OCR worker if not already done
      if (!this.ocrWorker) {
        this.ocrWorker = await createWorker('eng');
      }

      // Pre-process image for better OCR results
      const processedImagePath = await this.preprocessImage(filePath);
      
      const { data: { text, confidence } } = await this.ocrWorker.recognize(processedImagePath);
      
      // Clean up processed image if it's different from original
      if (processedImagePath !== filePath) {
        fs.unlinkSync(processedImagePath);
      }
      
      return {
        content: text.trim(),
        metadata: {
          wordCount: text.trim().split(/\s+/).length,
          extractionMethod: 'tesseract-ocr',
          confidence: Math.round(confidence)
        }
      };
    } catch (error) {
      console.error('OCR extraction failed:', error);
      throw new Error(`OCR failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Pre-process image for better OCR results
   */
  private async preprocessImage(filePath: string): Promise<string> {
    try {
      const image = sharp(filePath);
      const metadata = await image.metadata();
      
      // Skip processing if image is already high quality
      if (metadata.width && metadata.width > 1000) {
        return filePath;
      }
      
      // Create processed version with unique name to avoid "same file for input and output" error
      const timestamp = Date.now();
      const parsedPath = path.parse(filePath);
      const processedPath = path.join(parsedPath.dir, `${parsedPath.name}_processed_${timestamp}${parsedPath.ext}`);
      
      await image
        .resize(null, 1200, { 
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: false 
        })
        .sharpen(1, 1, 2)
        .normalize()
        .toFile(processedPath);
      
      return processedPath;
    } catch (error) {
      console.warn('Image preprocessing failed, using original:', error);
      return filePath;
    }
  }

  /**
   * Split text into chunks for better embeddings
   */
  splitIntoChunks(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      if (chunk.trim().length > 0) {
        chunks.push(chunk.trim());
      }
      
      // Break if we've reached the end
      if (i + chunkSize >= words.length) break;
    }
    
    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Extract text from CSV files
   */
  private async extractFromCSV(filePath: string): Promise<ExtractedText> {
    return new Promise((resolve, reject) => {
      const rows: string[] = [];
      let headerRow: string[] = [];
      let isFirstRow = true;
      
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('headers', (headers) => {
          headerRow = headers;
        })
        .on('data', (row) => {
          if (isFirstRow) {
            // Add header row as readable text
            rows.push(`Headers: ${headerRow.join(', ')}`);
            isFirstRow = false;
          }
          
          // Convert row object to readable text
          const rowText = Object.entries(row)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');
          rows.push(rowText);
        })
        .on('end', () => {
          const content = rows.join('\n');
          resolve({
            content,
            metadata: {
              wordCount: content.split(/\s+/).length,
              extractionMethod: 'csv-parser'
            }
          });
        })
        .on('error', reject);
    });
  }

  /**
   * Extract text from Excel files (.xlsx, .xls)
   */
  private async extractFromExcel(filePath: string): Promise<ExtractedText> {
    const workbook = XLSX.readFile(filePath);
    const allText: string[] = [];
    
    // Process each worksheet
    workbook.SheetNames.forEach(sheetName => {
      allText.push(`--- Sheet: ${sheetName} ---`);
      
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      // Convert each row to text
      jsonData.forEach((row: any, index: number) => {
        if (Array.isArray(row) && row.length > 0) {
          const cleanRow = row.filter(cell => cell !== null && cell !== undefined && cell !== '');
          if (cleanRow.length > 0) {
            if (index === 0) {
              // First row as headers
              allText.push(`Headers: ${cleanRow.join(', ')}`);
            } else {
              // Data rows
              allText.push(`Row ${index}: ${cleanRow.join(', ')}`);
            }
          }
        }
      });
    });
    
    const content = allText.join('\n');
    
    return {
      content,
      metadata: {
        wordCount: content.split(/\s+/).length,
        extractionMethod: 'xlsx',
        pages: workbook.SheetNames.length
      }
    };
  }

  /**
   * Extract text from PPTX using pptx2json (extracts ALL text including from text boxes)
   */
  private async extractFromPPTXWithPptx2json(filePath: string): Promise<ExtractedText> {
    console.log(`Trying pptx2json extraction for: ${filePath}`);
    
    // Use pptx2json to extract ALL text including from text boxes and shapes
    const result: any = await pptx2json(filePath);
    
    const allText: string[] = [];
    
    // Extract text from all slides
    if (result && result.slides && Array.isArray(result.slides)) {
      console.log(`pptx2json found ${result.slides.length} slides`);
      
      result.slides.forEach((slide: any, index: number) => {
        const slideTexts: string[] = [];
        
        // Function to recursively extract all text from slide elements
        const extractTextRecursive = (obj: any) => {
          if (!obj) return;
          
          // Handle primitive strings directly (common in pptx2json output)
          if (typeof obj === 'string') {
            const trimmed = obj.trim();
            if (trimmed) {
              slideTexts.push(trimmed);
            }
            return;
          }
          
          // If this object has a text property, collect it
          if (obj.text && typeof obj.text === 'string' && obj.text.trim()) {
            slideTexts.push(obj.text.trim());
          }
          
          // If this object has a value property (for text fields), collect it
          if (obj.value && typeof obj.value === 'string' && obj.value.trim()) {
            slideTexts.push(obj.value.trim());
          }
          
          // Recursively process arrays
          if (Array.isArray(obj)) {
            obj.forEach(item => extractTextRecursive(item));
          }
          // Recursively process objects
          else if (typeof obj === 'object') {
            Object.values(obj).forEach(value => extractTextRecursive(value));
          }
        };
        
        // Extract all text from this slide
        extractTextRecursive(slide);
        
        if (slideTexts.length > 0) {
          allText.push(`--- Slide ${index + 1} ---`);
          allText.push(slideTexts.join('\n'));
          console.log(`pptx2json extracted ${slideTexts.length} text elements from slide ${index + 1}`);
        }
      });
    }
    
    const content = allText.join('\n\n');
    
    if (!content || content.trim().length < 10) {
      throw new Error('pptx2json extracted insufficient text');
    }
    
    console.log(`Successfully extracted ${content.length} characters using pptx2json`);
    
    return {
      content,
      metadata: {
        wordCount: content.split(/\s+/).length,
        extractionMethod: 'pptx2json',
        pages: result?.slides?.length || 0
      }
    };
  }

  /**
   * Extract text from PowerPoint files (.pptx)
   */
  private async extractFromPPTX(filePath: string): Promise<ExtractedText> {
    // Try pptx2json first (best for extracting text from text boxes and shapes)
    try {
      return await this.extractFromPPTXWithPptx2json(filePath);
    } catch (pptx2jsonError) {
      console.log('pptx2json failed, trying fallback methods:', pptx2jsonError);
    }
    
    // Fallback to original extraction methods
    try {
      console.log(`Extracting text from PPTX file using fallback methods: ${filePath}`);
      
      // Check if file exists and get its stats for debugging
      if (!fs.existsSync(filePath)) {
        throw new Error(`PPTX file does not exist: ${filePath}`);
      }
      
      const stats = fs.statSync(filePath);
      console.log(`PPTX file stats: size=${stats.size} bytes, modified=${stats.mtime}`);
      
      // Check if file is actually a zip file (PPTX is a zip container)
      const fileBuffer = fs.readFileSync(filePath);
      const isZip = fileBuffer.length > 4 && 
                    fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B && 
                    (fileBuffer[2] === 0x03 || fileBuffer[2] === 0x05 || fileBuffer[2] === 0x07);
      
      console.log(`PPTX file validation: isZip=${isZip}, firstBytes=[${fileBuffer.slice(0, 8).toString('hex')}]`);
      
      if (!isZip) {
        throw new Error(`File ${filePath} is not a valid ZIP/PPTX file (missing ZIP signature)`);
      }
      
      // Try officeparser first
      try {
        const config = {
          ignoreNotes: false,           // Include speaker notes for comprehensive extraction
          newlineDelimiter: '\n',       // Preserve line breaks
          outputErrorToConsole: false   // Silent errors, we'll handle them
        };
        
        console.log(`Attempting officeparser extraction on file: ${filePath} (${stats.size} bytes)`);
        
        const extractedText = await officeParser.parseOfficeAsync(filePath, config);
        
        // Check if we got meaningful content (more than 10 characters)
        // Accept short content as valid - slides may have minimal text
        if (extractedText && extractedText.trim().length > 10) {
          console.log(`Successfully extracted ${extractedText.length} characters from PPTX using officeparser`);
          
          return {
            content: extractedText.trim(),
            metadata: {
              wordCount: extractedText.trim().split(/\s+/).length,
              extractionMethod: 'officeparser',
              includesNotes: !config.ignoreNotes
            }
          };
        } else {
          console.log(`Officeparser extracted only ${extractedText?.trim().length || 0} characters, trying fallback method...`);
          console.log(`Officeparser content was: "${extractedText?.trim().substring(0, 100)}..."`);
        }
      } catch (officeParserError) {
        console.log(`Officeparser failed, trying fallback method:`, officeParserError);
      }
      
      // Fallback to node-pptx-parser for better extraction
      console.log(`Using node-pptx-parser as fallback for: ${filePath}`);
      
      const parser = new PptxParser(filePath);
      const parsedData: any = await parser.parse();
      
      // Debug: Log the structure of parsed data
      console.log(`PPTX Parser Response - Type: ${typeof parsedData}, Keys:`, Object.keys(parsedData || {}));
      console.log(`PPTX Parser Response - Full structure:`, JSON.stringify(parsedData, null, 2).substring(0, 500));
      
      // Check if parsedData has slides
      if (!parsedData) {
        throw new Error('Parser returned null/undefined');
      }
      
      // Try different possible data structures
      let slides: any[] = [];
      
      if (parsedData.slides && Array.isArray(parsedData.slides)) {
        slides = parsedData.slides;
        console.log(`Found ${slides.length} slides in parsedData.slides`);
      } else if (Array.isArray(parsedData)) {
        slides = parsedData;
        console.log(`parsedData is an array with ${slides.length} items`);
      } else if (parsedData.presentation && parsedData.presentation.slides) {
        slides = parsedData.presentation.slides;
        console.log(`Found ${slides.length} slides in parsedData.presentation.slides`);
      }
      
      if (slides.length === 0) {
        console.log(`No slides found. parsedData structure:`, parsedData);
        throw new Error('No slides could be extracted from PPTX file');
      }
      
      // Combine text from all slides by parsing XML
      const allText: string[] = [];
      slides.forEach((slide: any, index: number) => {
        console.log(`Slide ${index + 1} - processing XML from: ${slide.path}`);
        
        // Log a sample of the XML to debug
        const xmlSample = slide.xml?.substring(0, 500) || '';
        console.log(`XML sample from slide ${index + 1}:`, xmlSample);
        
        // Extract text from XML - PowerPoint text is in <a:t> tags
        const slideText: string[] = [];
        
        if (slide.xml) {
          // Use a more comprehensive regex that handles various text formats
          // This matches: <a:t>TEXT</a:t> including multiline and with attributes
          // Using [\s\S] to match any character including newlines (compatible with all TS versions)
          const textMatches = slide.xml.match(/<a:t[^>]*>([\s\S]+?)<\/a:t>/g);
          
          console.log(`Found ${textMatches?.length || 0} <a:t> tags in slide ${index + 1}`);
          
          if (textMatches && textMatches.length > 0) {
            textMatches.forEach((match: string, matchIndex: number) => {
              // Extract text between tags: <a:t>TEXT</a:t>
              const text = match.replace(/<a:t[^>]*>/, '').replace(/<\/a:t>/, '').trim();
              if (text) {
                slideText.push(text);
                if (matchIndex < 3) { // Log first 3 matches for debugging
                  console.log(`  Match ${matchIndex + 1}: "${text.substring(0, 50)}..."`);
                }
              }
            });
          }
        }
        
        if (slideText.length > 0) {
          allText.push(`--- Slide ${index + 1} ---`);
          allText.push(slideText.join('\n'));
          console.log(`Extracted ${slideText.join('').length} characters from slide ${index + 1}`);
        } else {
          console.log(`No text found in slide ${index + 1}`);
        }
      });
      
      const content = allText.join('\n\n');
      
      if (!content || content.trim().length === 0) {
        throw new Error('No text could be extracted from PPTX file after trying all extraction methods');
      }
      
      console.log(`Successfully extracted ${content.length} characters from ${slides.length} slides using node-pptx-parser`);
      
      return {
        content: content.trim(),
        metadata: {
          wordCount: content.trim().split(/\s+/).length,
          extractionMethod: 'node-pptx-parser',
          pages: slides.length
        }
      };
      
    } catch (error) {
      console.error(`PPTX extraction failed for ${filePath}:`, error);
      throw new Error(`PPTX parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    if (this.ocrWorker) {
      await this.ocrWorker.terminate();
      this.ocrWorker = null;
    }
  }
}

// Export singleton instance
export const textExtractionService = TextExtractionService.getInstance();