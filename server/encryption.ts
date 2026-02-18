import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;

// Derive a key from the master password using scrypt
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH);
}

// Get encryption key from environment with strict validation
function getEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required for password vault security. ' +
      'Please set ENCRYPTION_KEY in Replit Secrets to a secure 64-character hexadecimal key.'
    );
  }
  
  // Validate key format (should be 64 hex characters = 256 bits)
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    console.warn('WARNING: ENCRYPTION_KEY should be a 64-character hexadecimal string for optimal security.');
  }
  
  return key;
}

/**
 * Encrypt a password using AES-256-GCM
 * Returns a string in format: salt:iv:tag:encryptedData (all base64 encoded)
 */
export function encryptPassword(plaintext: string): string {
  try {
    const masterKey = getEncryptionKey();
    
    // Generate random salt and IV
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    
    // Derive encryption key from master key and salt
    const key = deriveKey(masterKey, salt);
    
    // Create cipher and encrypt
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    // Get authentication tag
    const tag = cipher.getAuthTag();
    
    // Combine salt, IV, tag, and encrypted data
    const combined = `${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted}`;
    
    return combined;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt password');
  }
}

/**
 * Decrypt a password encrypted with encryptPassword
 * Expects input in format: salt:iv:tag:encryptedData (all base64 encoded)
 */
export function decryptPassword(encryptedData: string): string {
  try {
    const masterKey = getEncryptionKey();
    
    // Split the combined string
    const parts = encryptedData.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted data format');
    }
    
    const [saltB64, ivB64, tagB64, encrypted] = parts;
    
    // Convert from base64
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    
    // Derive decryption key
    const key = deriveKey(masterKey, salt);
    
    // Create decipher and decrypt
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt password');
  }
}

/**
 * Generate a random encryption key for use as ENCRYPTION_KEY
 * This is a utility function for generating secure keys
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}
