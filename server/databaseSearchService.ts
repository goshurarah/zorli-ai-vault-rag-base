import { db } from "./db";
import { documents as documentsTable } from "@shared/schema";
import { eq, sql, ilike } from "drizzle-orm";

export interface DatabaseSearchResult {
  id: string;
  filename: string;
  extractedText: string;
  fileType: string;
  relevanceScore: number;
  matchedContent: string; // Preview of relevant content
}

export class DatabaseSearchService {
  /**
   * Search documents by extracted text content using simple text matching
   * This searches directly in the Supabase database extractedText field
   */
  async searchDocuments(
    userId: string, 
    query: string, 
    limit: number = 5
  ): Promise<DatabaseSearchResult[]> {
    try {
      console.log(`Searching database documents for user ${userId} with query: "${query}"`);
      
      // First, try exact phrase matching for better results
      const exactResults = await this.searchByExactPhrase(userId, query, limit);
      
      // If we have good exact matches, return those
      if (exactResults.length >= 2) {
        console.log(`Found ${exactResults.length} exact phrase matches`);
        return exactResults;
      }
      
      // Otherwise, fall back to keyword search
      const keywordResults = await this.searchByKeywords(userId, query, limit);
      
      // Combine results, prioritizing exact matches
      const combined = [...exactResults, ...keywordResults];
      const uniqueResults = this.removeDuplicates(combined);
      
      console.log(`Found ${uniqueResults.length} total matches after deduplication`);
      return uniqueResults.slice(0, limit);
      
    } catch (error) {
      console.error('Database search failed:', error);
      throw new Error(`Database search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Search for documents containing the exact phrase or very similar content
   */
  private async searchByExactPhrase(
    userId: string, 
    query: string, 
    limit: number
  ): Promise<DatabaseSearchResult[]> {
    const searchTerms = query.toLowerCase().trim();
    
    const documents = await db
      .select({
        id: documentsTable.id,
        filename: documentsTable.filename,
        extractedText: documentsTable.extractedText,
        fileType: documentsTable.fileType,
      })
      .from(documentsTable)
      .where(
        sql`${documentsTable.userId} = ${userId} 
            AND ${documentsTable.extractedText} IS NOT NULL 
            AND LOWER(${documentsTable.extractedText}) LIKE ${'%' + searchTerms + '%'}`
      )
      .limit(limit);

    return documents
      .filter(doc => doc.extractedText) // Ensure we have content
      .map(doc => ({
        id: doc.id,
        filename: doc.filename,
        extractedText: doc.extractedText!,
        fileType: doc.fileType,
        relevanceScore: this.calculateRelevanceScore(doc.extractedText!, query),
        matchedContent: this.extractRelevantContent(doc.extractedText!, query)
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Search for documents containing individual keywords from the query
   */
  private async searchByKeywords(
    userId: string, 
    query: string, 
    limit: number
  ): Promise<DatabaseSearchResult[]> {
    // Extract meaningful keywords (skip common words)
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !this.isCommonWord(word))
      .slice(0, 5); // Limit to top 5 keywords

    if (keywords.length === 0) {
      return [];
    }

    // Build SQL condition to search for any keyword
    const keywordConditions = keywords.map(keyword => 
      sql`LOWER(${documentsTable.extractedText}) LIKE ${'%' + keyword + '%'}`
    );
    
    const combinedCondition = sql`(${keywordConditions.reduce((acc, condition, index) => 
      index === 0 ? condition : sql`${acc} OR ${condition}`
    )})`;

    const documents = await db
      .select({
        id: documentsTable.id,
        filename: documentsTable.filename,
        extractedText: documentsTable.extractedText,
        fileType: documentsTable.fileType,
      })
      .from(documentsTable)
      .where(
        sql`${documentsTable.userId} = ${userId} 
            AND ${documentsTable.extractedText} IS NOT NULL 
            AND ${combinedCondition}`
      )
      .limit(limit * 2); // Get more results for better sorting

    return documents
      .filter(doc => doc.extractedText) // Ensure we have content
      .map(doc => ({
        id: doc.id,
        filename: doc.filename,
        extractedText: doc.extractedText!,
        fileType: doc.fileType,
        relevanceScore: this.calculateRelevanceScore(doc.extractedText!, query),
        matchedContent: this.extractRelevantContent(doc.extractedText!, query)
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  /**
   * Calculate a simple relevance score based on keyword frequency and positioning
   */
  private calculateRelevanceScore(text: string, query: string): number {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let score = 0;

    // Exact phrase match gets highest score
    if (lowerText.includes(lowerQuery)) {
      score += 10;
    }

    // Individual keyword matches
    const keywords = lowerQuery.split(/\s+/).filter(word => word.length > 2);
    keywords.forEach(keyword => {
      const matches = (lowerText.match(new RegExp(keyword, 'g')) || []).length;
      score += matches * 2;
    });

    // Bonus for matches near the beginning of the document
    const firstHalf = lowerText.substring(0, lowerText.length / 2);
    if (firstHalf.includes(lowerQuery)) {
      score += 3;
    }

    return score;
  }

  /**
   * Extract the most relevant content snippet containing the query terms
   */
  private extractRelevantContent(text: string, query: string): string {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    // Try to find the exact query first
    let index = lowerText.indexOf(lowerQuery);
    
    // If not found, try the first keyword
    if (index === -1) {
      const keywords = lowerQuery.split(/\s+/).filter(word => word.length > 2);
      if (keywords.length > 0) {
        index = lowerText.indexOf(keywords[0]);
      }
    }
    
    if (index === -1) {
      // Fallback to beginning of text
      return text.substring(0, 300) + (text.length > 300 ? '...' : '');
    }
    
    // Extract context around the match
    const start = Math.max(0, index - 150);
    const end = Math.min(text.length, index + 300);
    let snippet = text.substring(start, end);
    
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet += '...';
    
    return snippet;
  }

  /**
   * Remove duplicate documents from search results
   */
  private removeDuplicates(results: DatabaseSearchResult[]): DatabaseSearchResult[] {
    const seen = new Set<string>();
    return results.filter(result => {
      if (seen.has(result.id)) {
        return false;
      }
      seen.add(result.id);
      return true;
    });
  }

  /**
   * Check if a word is too common to be useful for search
   */
  private isCommonWord(word: string): boolean {
    const commonWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 
      'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 
      'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 
      'did', 'man', 'men', 'put', 'say', 'she', 'too', 'use', 'what', 'is', 
      'this', 'that', 'with', 'have', 'from', 'they', 'know', 'want', 'been',
      'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just',
      'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'them',
      'well', 'were'
    ]);
    return commonWords.has(word);
  }
}

// Export singleton instance
export const databaseSearchService = new DatabaseSearchService();