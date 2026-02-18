# Zorli AI Vault - Project Documentation

## Overview
Zorli AI Vault is a full-stack TypeScript application, built with a Next.js-like architecture using React and Express. Its primary purpose is to provide secure file management, enhanced with AI-powered analysis, integrated payment processing, and efficient background job queues. The project aims to offer a robust and scalable platform for secure digital asset management and intelligent data processing, targeting individuals and businesses requiring advanced security and AI capabilities.

## User Preferences
- Prefers comprehensive, well-documented code structure
- Values security and best practices
- Wants fully functional prototypes with proper TypeScript typing
- Appreciates clean, maintainable architecture patterns

## System Architecture

### UI/UX Decisions
The project includes both web and mobile applications:

**Web Application**: Frontend uses React 18 with TypeScript, styled using TailwindCSS and Shadcn/ui. Navigation is client-side with `wouter` for a SPA experience, including role-based access control and active page highlighting. Landing page features Password Vault feature section (between "How It Works" and "Pricing") with gradient styling, feature list, visual demo cards, and comprehensive pricing section displaying all three subscription tiers (Free $0, Basic $9.97 - Recommended, Plus $19.97) with simplified feature lists (only showing file upload and AI prompt limits), positioned before the "Ready to Get Started?" CTA section. All plan buttons use "Get Started" text. Admin dashboard features welcome header with "Zorli" title, personalized greeting (displays user's firstName + lastName if available, otherwise falls back to username), and profile picture display. Admin users display "--" for Plan, Files, and AI Prompts columns (plain text styling) since these features don't apply to admin accounts. Smart Finder is available as both a floating chatbot (dashboard) and dedicated full-page interface (sidebar navigation with Sparkles icon). The dedicated Smart Finder page (`/smart-finder`) features a full-page chat interface with instant offline persistence (localStorage hydration), cross-device sync (database fetch), profile pictures in user messages, voice recording with Whisper transcription, AI prompt limit enforcement, copy/clear history controls, and graceful error handling. Chat history syncs between floating and dedicated modes. Dashboard includes interactive AI search input field "What are you looking for?" between usage stats and file upload - users can type messages directly and press Enter or click send to automatically open the AI chatbot with their query auto-sent.

**Mobile Application**: A production-ready React Native mobile app with Expo SDK 52 and TypeScript. Provides complete feature parity with the web version, including native mobile features (camera, photo gallery, SecureStore) and forgot password functionality with OTP email verification. Landing screen features "How It Works" section (between Features and Stats) displaying three-step process (Upload Files → AI Analysis → Get Insights) with numbered badges and descriptions matching the web version. Also includes Password Vault feature section (between Stats and Pricing) with gradient card styling, feature list with checkmarks, demo password cards, encryption badge, and comprehensive pricing section displaying all three subscription tiers (Free $0, Basic $9.97 - Recommended, Plus $19.97) with simplified feature lists (only showing file upload and AI prompt limits), positioned before the "Ready to Get Started?" CTA section. All plan buttons use "Get Started" text. Dashboard includes interactive AI search input field "What are you looking for?" between usage stats and quick actions - users can type messages directly and press send or keyboard return to automatically navigate to the AI Assistant with their query auto-sent. Uses React Navigation for role-based tab navigation:
- **Admin Users**: See 3-tab bottom navigation (Admin Dashboard, Admin Settings, Payments) with admin-specific features:
  - **Admin Dashboard**: Welcome header with "Zorli" title, personalized greeting, profile picture, comprehensive statistics (user counts, subscriptions, platform usage), searchable user management table with email verification status badges (blue for verified, red for not verified, WCAG AA compliant), multi-select batch deletion (Select, Select All, Delete Selected buttons), and user deletion with protection (admin users and current user cannot be deleted or selected)
  - **Admin Settings**: Profile picture management, username editing, admin identity display
  - **Payments**: Transaction history with user, plan, amount, billing period, and status details
- **Regular Users**: See 5-tab bottom navigation (Dashboard, Vault, AI Assistant, Passwords, Profile) with full app features
- Authentication flow with SecureStore for JWT token persistence
- Role detection prevents navigation flicker and enforces access control
- Profile picture loading supports Supabase storage paths, absolute URLs, and relative paths

### Technical Implementations
- **Core Functionality**: Secure file uploads, AI analysis (GPT-5, DALL-E 3), subscription system, AES-256-GCM encrypted password vault, and Admin Dashboard.
- **Backend**: Express.js and Node.js for API routes, file handling (Multer), and integrations with Stripe and OpenAI SDKs.
- **Frontend (Web)**: React 18, TypeScript, TailwindCSS, Shadcn/ui, and TanStack Query.
- **Frontend (Mobile)**: React Native with Expo SDK 52, TypeScript, React Navigation, Expo Camera/ImagePicker/DocumentPicker, and SecureStore. Reuses existing backend APIs.
- **Database Operations**: Supabase PostgreSQL with Drizzle ORM.
- **Background Jobs**: BullMQ, leveraging Redis for job queues.
- **Storage**: Supabase Storage for all file operations in a private `documents` bucket (50MB limit per file, no MIME type restrictions).
- **Security**: Zod for input validation, secure environment variables, CORS, security headers, robust error handling, cross-account data isolation, and reactive authentication guards.
- **Payment Processing**: Production-ready Stripe Checkout Sessions integration with Stripe live mode (credentials stored in Replit Secrets), server-side session creation, metadata-based user tracking, and synchronous webhook handling (`checkout.session.completed`) for updating user, subscription, and payment tables atomically with retry logic. Three subscription plans: Free ($0), Basic ($9.97/month, price_1SLQXvP7PiwxdBzDzLndco8H), and Plus ($19.97/month, price_1SLQZaP7PiwxdBzDquOM273o).
- **Feature Specifications**:
    - **Authentication**: JWT token-based login, registration, validation, and logout. Includes email verification for new signups and forgot password flow with OTP email verification. Usernames are generated from first name + last name during signup (e.g., "John Doe") for personalized greetings.
    - **Email Verification System**: New user signups require email verification before account access. Features JWT-based verification tokens with 30-minute expiry, email sent via Gmail SMTP with one-click verification link, auto-login after verification, and comprehensive security enforcement (sign-in and session validation both check verification status). Web users verify via `/verify-email` page; mobile users can verify via web link.
    - **Forgot Password System**: Email-based password reset using 6-digit OTP codes sent via Gmail SMTP. Features 10-minute OTP expiry, bcrypt password hashing (12 salt rounds), secure validation, and two-step dialog UI (email input → OTP/password reset).
    - **Profile Customization**: Profile picture uploads (Supabase Storage, signed URLs) and username changes with real-time validation.
    - **File Management**: Upload, retrieve, delete files with metadata and subscription limits. Supports batch deletion with multi-select functionality (web: "Select" button toggles selection mode with checkboxes hidden by default, mobile: long-press to activate selection mode). Batch deletion displays full-screen loading overlay with spinner and "Deleting files, please wait..." message, disabling the entire file manager during deletion. Document filter includes PDF, DOCX, XLSX, DOC, XLS, and PPTX files. Image preview modal allows users to click on uploaded images to view enlarged previews (web: Dialog modal with AuthenticatedImage component, mobile: React Native Modal with full-size image loading and close controls).
    - **Subscription Management**: Access to plans, status, usage statistics, and Stripe integration for checkout/cancellations. Usage tracked in `subscription_usage`.
    - **Password Vault**: Securely create, retrieve, update, delete encrypted credentials using AES-256-GCM. Supports batch deletion with multi-select functionality (web: "Select" button toggles selection mode with checkboxes, mobile: long-press to activate selection mode). Robust error handling tracks success/failure counts, keeps failed items selected for retry.
    - **User Dashboard**: Real-time usage statistics (Files Uploaded, AI Analyses, Storage Used, Active Jobs).
    - **Admin Dashboard**: Comprehensive interface for subscription metrics, user management, and payment transactions.
    - **AI Services**: Endpoints for text analysis and image generation with usage tracking.
    - **Smart Finder (AI Chat Assistant)**: Conversational document assistant using vector search (RAG) and GPT-4o-mini. Handles tabular data, provides citation-based responses, tracks AI prompt usage, and syncs chat history across devices.
    - **Job Management**: Track user-specific background job statuses.

### Design System - Zorli Brand Kit
The application uses a comprehensive design system called the **Zorli Brand Kit**, providing consistent branding and visual identity across web and mobile platforms.

**Color Palette**:
- **Vault Blue** (#2B6CB0): Primary brand color used for buttons, links, and key UI elements
- **Sky Trust** (#A0C4E8): Light blue accent for secondary elements and highlights
- **Soft Cloud** (#F7FAFC): Very light background color for clean, spacious layouts
- **Warm Stone** (#E2E8F0): Neutral gray for borders, dividers, and subtle backgrounds
- **Deep Slate** (#2D3748): Dark gray for text, headers, and strong contrast
- **Success Green** (#48BB78): Confirmation messages and success states
- **Error Red** (#E53E3E): Error messages and destructive actions

**Shade Scale** (Vault Blue progression):
- vault-100 (#EBF8FF): Lightest - hover states, subtle backgrounds
- vault-300 (#A0C4E8): Light - same as Sky Trust
- vault-500 (#2B6CB0): Medium - primary brand color
- vault-700 (#2C5282): Dark - active states, emphasis
- vault-900 (#1A365D): Darkest - strong emphasis, dark mode accents

**Typography**:
- **Primary Font**: Inter (with system fallbacks: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto)
- **Heading Styles**: Semi-bold (600), Vault Blue color, consistent 8px bottom margin
- **Border Radius**: Small (8px) for buttons/badges, Medium (12px) for cards/modals
- **Shadows**: Subtle elevation with small/medium variants for depth perception

**Implementation**:
- **Web App**: TailwindCSS theme extended with Zorli colors via CSS variables in `client/src/index.css`. Additional component styles in `client/src/styles/zorli-brand-kit.css` provide utility classes (.btn, .card, .input, etc.) for enhanced styling
- **Mobile App**: React Native StyleSheet theme in `mobile/src/theme/zorli-brand-kit.ts` exports Colors, Typography, Spacing, BorderRadius, Shadows, and pre-built ComponentStyles for consistent mobile UI

**Benefits**:
- Cohesive visual identity across all platforms
- Improved accessibility with proper contrast ratios
- Faster development with pre-built component styles
- Easy theme maintenance through centralized design tokens
- Professional, modern aesthetic aligned with brand values

### Stripe Checkout Flow
1.  **Upgrade Page**: User initiates checkout from `/upgrade`, frontend calls POST `/api/create-checkout-session`.
2.  **Stripe Checkout**: User completes payment on Stripe's hosted page, redirected to `/success`.
3.  **Webhook Processing**: Stripe sends `checkout.session.completed` event to webhook, which updates `users`, `user_subscriptions`, `subscription_usage`, and `payments` tables with retry logic and enhanced logging.
4.  **Success Page**: Polls `/api/subscriptions/current` to detect subscription update, then invalidates queries and redirects to dashboard.

## External Dependencies
- **Database**: Supabase PostgreSQL
- **Object Storage**: Supabase Storage
- **AI Services**: OpenAI (GPT-5, DALL-E 3)
- **Payment Processing**: Stripe (Stripe Elements, Webhooks, Checkout)
- **Job Queue**: BullMQ (requires Redis)
- **Authentication**: Custom JWT token-based authentication (bcrypt)
- **ORM**: Drizzle ORM
- **File Uploads**: Multer (web), Expo native pickers (mobile)
- **Mobile Framework**: Expo SDK 52 with React Native