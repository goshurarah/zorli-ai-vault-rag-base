// This file unsets Replit Secrets for Stripe and loads from .env instead
// This must run before any other imports

// Unset Replit Secrets so .env file takes precedence
delete process.env.STRIPE_SECRET_KEY;
delete process.env.VITE_STRIPE_PUBLIC_KEY;

// Now load from .env file
import dotenv from 'dotenv';
dotenv.config();
