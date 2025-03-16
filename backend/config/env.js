// File: backend/config/env.js

import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Environment variable validation
function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    console.warn(`⚠️ WARNING: Required environment variable ${key} is not set.`);
  }
  return value;
}

// Configuration object with all environment variables
const config = {
  // Server config
  port: process.env.PORT || 5050,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // API Keys
  openai: {
    apiKey: requireEnv('OPENAI_API_KEY'),
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "<YOUR_GEMINI_API_KEY>",
    isConfigured: function() {
      return this.apiKey && this.apiKey !== "<YOUR_GEMINI_API_KEY>";
    }
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY || "",
    isConfigured: function() {
      return this.apiKey && this.apiKey.startsWith('sk-ant-');
    }
  },
  grok: {
    apiKey: process.env.GROK_API_KEY || "",
    isConfigured: function() {
      return this.apiKey && this.apiKey.startsWith('xai-');
    }
  },
  
  // Supabase config
  supabase: {
    url: requireEnv('SUPABASE_URL'),
    serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  },
  
  // Stripe config
  stripe: {
    secretKey: requireEnv('STRIPE_SECRET_KEY'),
    webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
    priceId: requireEnv('STRIPE_PRICE_ID'),
  }
};

// Validate critical configuration
function validateConfig() {
  // Log configuration status
  console.log("API Keys configured:", {
    openai: config.openai.apiKey ? "Yes" : "No",
    gemini: config.gemini.isConfigured() ? "Yes" : "No",
    claude: config.claude.isConfigured() ? "Yes" : "No",
    grok: config.grok.isConfigured() ? "Yes" : "No",
    stripe: config.stripe.secretKey ? "Yes" : "No",
    supabase: config.supabase.url && config.supabase.serviceKey ? "Yes" : "No"
  });
  
  // Return true if configuration is valid
  return !!config.openai.apiKey && !!config.supabase.url && !!config.supabase.serviceKey;
}

// Run validation
validateConfig();

// Export the configuration
export default config;