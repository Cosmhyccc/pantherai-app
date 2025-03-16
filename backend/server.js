import OpenAI from "openai";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import util from "util";
import { fileURLToPath } from "url";
import { processUploadedFiles, readFileContent, fileToDataURL, prepareImagesForModel } from './fileUtils.js';
import { 
  isGeminiConfigured, 
  generateGeminiResponse, 
  handleGeminiStreamingRequest,
  testGeminiConnection 
} from './geminiService.js';

import { 
  isOpenAIConfigured, 
  generateOpenAIResponse, 
  generateOpenAIStreamingResponse 
} from './openaiService.js';

import { 
  isClaudeConfigured, 
  generateClaudeResponse, 
  generateClaudeStreamingResponse,
  testClaudeConnection
} from './claudeService.js';
  
import { 
  isGrokConfigured, 
  generateGrokResponse, 
  generateGrokStreamingResponse,
  testGrokConnection
} from './grokService.js'; 

// ** Integrations: Supabase and Stripe **
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
// Import the config module instead of dotenv
import config from './config/env.js';

// Initialize Supabase client (using service role key for admin access)
const supabaseUrl = config.supabase.url;
const supabaseServiceKey = config.supabase.serviceKey;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Check if Stripe key is configured properly
const STRIPE_SECRET_KEY = config.stripe.secretKey;
if (!STRIPE_SECRET_KEY) {
    console.error("⚠️ WARNING: STRIPE_SECRET_KEY is not set. Subscription features will not work.");
    console.error("Make sure you have a .env file with STRIPE_SECRET_KEY=sk_... in your project root.");
}

// Initialize Stripe client with error handling
let stripe;
try {
    stripe = new Stripe(STRIPE_SECRET_KEY || 'dummy_key_for_development_only', { apiVersion: "2022-11-15" });
    console.log("✅ Stripe initialized successfully");
} catch (err) {
    console.error("🚨 Failed to initialize Stripe:", err.message);
    // Create a dummy stripe object for development without API key
    stripe = {
        checkout: { sessions: { create: async () => ({ url: '#dummy-checkout-url' }) } },
        subscriptions: { retrieve: async () => ({ status: 'active' }) },
        webhooks: { constructEvent: () => ({ type: 'dummy', data: { object: {} } }) }
    };
}

// Define file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const sessionId = req.body.sessionId || 'unknown';
        console.log(`📁 Processing file upload for session: ${sessionId}, file: ${file.originalname}, mimetype: ${file.mimetype}`);
        
        const sessionDir = path.join(uploadsDir, sessionId);
        if (!fs.existsSync(sessionDir)) {
            console.log(`Creating directory: ${sessionDir}`);
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        cb(null, sessionDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const fileExt = path.extname(file.originalname);
        const fileName = file.fieldname + '-' + uniqueSuffix + fileExt;
        console.log(`Generated unique filename: ${fileName} for ${file.originalname}`);
        cb(null, fileName);
    }
});

// Enhanced file size limits and error handling
const upload = multer({ 
    storage, 
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: function(req, file, cb) {
        console.log(`Filtering file: ${file.originalname}, mimetype: ${file.mimetype}`);
        // Accept images and common document formats
        if (file.mimetype.startsWith('image/') || 
            file.mimetype.includes('pdf') ||
            file.mimetype.includes('text/') ||
            file.mimetype.includes('application/json') ||
            file.mimetype.includes('csv')) {
            cb(null, true);
        } else {
            console.log(`Rejecting file: ${file.originalname} with mimetype: ${file.mimetype}`);
            cb(null, false);
        }
    }
}).any();

// Add this enhanced error-handling upload middleware function
function enhancedUpload(req, res, next) {
    console.log("🔍 Request received for upload with content-type:", req.headers['content-type']);
    
    upload(req, res, function(err) {
        if (err) {
            console.error("❌ Multer upload error:", err);
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({ error: "File too large. Maximum size is 10MB." });
                }
                return res.status(400).json({ error: `Upload error: ${err.message}` });
            }
            return res.status(500).json({ error: `Server error during upload: ${err.message}` });
        }
        
        // Log successful uploads
        if (req.files && req.files.length > 0) {
            console.log(`✅ Successfully uploaded ${req.files.length} files:`, 
                req.files.map(f => ({ name: f.originalname, size: f.size, path: f.path })));
        } else {
            console.log("No files were uploaded with this request");
        }
        
        next();
    });
}

// Initialize Express
const app = express();
// Use JSON parser for API routes (excluding Stripe webhooks)
app.use('/api', express.json());

// Better CORS configuration - allow all origins during development
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Serve static files from the chatbot directory
app.use(express.static(path.join(__dirname, '../chatbot')));

// Store session data in memory
const sessionFiles = new Map();
const userConversations = new Map();
const userSelectedModel = new Map();

// Load API keys
const OPENAI_API_KEY = config.openai.apiKey;
const GEMINI_API_KEY = config.gemini.apiKey;
console.log("Gemini API Key configured:", GEMINI_API_KEY ? "Yes" : "No");
const STRIPE_WEBHOOK_SECRET = config.stripe.webhookSecret;

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Helper: check if user is subscribed (with improved error handling)
async function isUserSubscribed(userId) {
    try {
        if (!userId) return false;
        
        const { data: profile, error } = await supabase
            .from('users')
            .select('is_subscribed, stripe_subscription_id')
            .eq('id', userId)
            .maybeSingle();
            
        if (error) {
            console.error("Error checking subscription status:", error);
            return false;
        }
        
        // If we have a Stripe subscription ID, verify it's active with Stripe
        if (profile?.stripe_subscription_id) {
            try {
                const subscription = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
                const isActive = subscription.status === 'active' || subscription.status === 'trialing';
                
                // If status in DB doesn't match Stripe, update it
                if (profile.is_subscribed !== isActive) {
                    await supabase
                        .from('users')
                        .update({ is_subscribed: isActive })
                        .eq('id', userId);
                }
                
                return isActive;
            } catch (stripeErr) {
                console.error("Stripe subscription check error:", stripeErr);
                // Fall back to using the database value
                return profile?.is_subscribed || false;
            }
        }
        
        // Default to database value if no Stripe ID
        return profile?.is_subscribed || false;
    } catch (err) {
        console.error("Exception checking subscription:", err);
        return false;
    }
}

// Create a Supabase Auth webhook listener for new users
app.post("/auth-webhook", express.json(), async (req, res) => {
    const { type, record } = req.body;
    console.log("Auth webhook received:", type);
    
    if (type === 'USER_CREATED') {
        try {
            // Create user record in the users table
            const { error } = await supabase
                .from('users')
                .insert({
                    id: record.id,
                    email: record.email,
                    is_subscribed: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
                
            if (error) {
                console.error("Error creating user record:", error);
                return res.status(500).json({ error: error.message });
            }
            
            console.log(`✅ Created user record for ${record.email}`);
            return res.json({ success: true });
        } catch (err) {
            console.error("Auth webhook error:", err);
            return res.status(500).json({ error: err.message });
        }
    }
    
    return res.json({ received: true });
});

// ** Chat API Endpoint (non-streaming) **
app.post("/api/chat", enhancedUpload, async (req, res) => {
  try {
    const { sessionId, message, model } = req.body;
    console.log(`Request body: sessionId=${sessionId}, model=${model}, message=${message?.substring(0, 50)}`);
    console.log(`Files attached: ${req.files?.length || 0}`);
    
    if (!sessionId || (!message && (!req.files || req.files.length === 0))) {
      return res.status(400).json({ error: "Session ID and either message or files are required." });
    }
    
    // ** Authenticate user via Supabase JWT **
    const authHeader = req.headers.authorization;
    console.log("Auth header received:", authHeader ? "Yes" : "No");
    
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }
    
    // Log the token format to debug
    console.log("Auth header format:", authHeader.substring(0, 15) + "...");
    
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: "Malformed Authorization header" });
    }
    
    try {
      const { data, error: authError } = await supabase.auth.getUser(token);
      
      if (authError) {
        console.error("🚨 AUTH ERROR:", authError.message);
        return res.status(401).json({ error: "Authentication failed: " + authError.message });
      }
      
      if (!data.user) {
        console.error("🚨 ERROR: No user found for token");
        return res.status(401).json({ error: "No user found for this token" });
      }
      
      console.log("✅ Authenticated user:", data.user.email);
      
      // Check subscription status with better error handling
      const isSubscribed = await isUserSubscribed(data.user.id);
      console.log(`User ${data.user.email} subscription status:`, isSubscribed);
      
      // Check if this is a new chat or existing
      const { data: existingChat } = await supabase.from('chats').select('messages, message_count').eq('id', sessionId).eq('user_id', data.user.id).maybeSingle();
      
      // Enforce free tier chat limits
      if (!isSubscribed) {
        if (!existingChat) {
          // Free user starting a new chat: limit 3 chats
          const { count: totalChats } = await supabase.from('chats').select('*', { count: 'exact', head: true }).eq('user_id', data.user.id);
          if (totalChats >= 3) {
            return res.status(403).json({ error: "Free tier limit reached: Maximum 3 chats allowed. Please upgrade to continue." });
          }
        } else if (existingChat.message_count >= 20) {
          // Free user continuing chat: limit 20 messages per chat
          return res.status(403).json({ error: "Free tier limit: Maximum 20 messages per chat reached. Please start a new chat or upgrade for unlimited access." });
        }
      }
      
      // Process any uploaded files for this message
      let uploadedFiles = [];
      if (req.files && req.files.length > 0) {
        try {
          uploadedFiles = processUploadedFiles(req.files, sessionId, sessionFiles);
          console.log(`📁 Processed ${uploadedFiles.length} files for session ${sessionId}`);
        } catch (fileError) {
          console.error("❌ Error processing uploaded files:", fileError);
          return res.status(500).json({ error: "Error processing uploaded files: " + fileError.message });
        }
      }
      
      // Initialize new conversation in memory if needed
      if (!userConversations.has(sessionId)) {
        userConversations.set(sessionId, [{ role: "system", content: "You are PantherAI, a helpful assistant." }]);
        userSelectedModel.set(sessionId, model || "gpt-3.5-turbo");
      }
      
      const conversationHistory = userConversations.get(sessionId);
      
      // Handle new user message and attached files
      const imageFiles = req.files ? req.files.filter(f => f.mimetype.startsWith('image/')) : [];
      const textFiles = req.files ? req.files.filter(f => !f.mimetype.startsWith('image/')) : [];
      
      // Process text file attachments (include their content in the prompt)
      let textFilesContent = "";
      if (textFiles.length > 0) {
        try {
          const textFilesInfo = await Promise.all(textFiles.map(async (file) => {
            let fileInfo = `- ${file.originalname} (${file.mimetype}, ${(file.size / 1024).toFixed(2)} KB)`;
            if (file.mimetype.startsWith('text/') || file.mimetype.includes('json') || file.mimetype.includes('csv')) {
              try {
                const fileContent = await readFileContent(file.path);
                if (fileContent) {
                  fileInfo += `\n\nContent of ${file.originalname}:\n\`\`\`\n${fileContent}\n\`\`\``;
                }
              } catch (err) {
                console.error(`Error reading text file ${file.path}:`, err);
              }
            } else {
              fileInfo += "\n[Binary file]";
            }
            return fileInfo;
          }));
          
          if (textFilesInfo.length > 0) {
            textFilesContent = `I've attached the following text-based files:\n${textFilesInfo.join('\n\n')}\n\n`;
          }
        } catch (textFileError) {
          console.error("Error processing text files:", textFileError);
          textFilesContent = "I've attached some text files, but they couldn't be processed properly.";
        }
      }
      
      // Append the user's text (and text file content if any) to the conversation
      let userContent = message || '';
      if (textFilesContent) {
        userContent += userContent ? '\n\n' : '';
        userContent += textFilesContent;
      }
      
      // Ensure we have valid user content if no message but files are present
      if (!userContent && (imageFiles.length > 0 || textFiles.length > 0)) {
        userContent = "Please analyze the attached files.";
      }
      
      conversationHistory.push({ role: "user", content: userContent });
      
      let selectedModel = userSelectedModel.get(sessionId) || "gpt-3.5-turbo";
      if (model) selectedModel = model;
      userSelectedModel.set(sessionId, selectedModel);
      
      // ** Model access control for free users **
      const premiumModels = ["gpt-4", "claude", "grok", "deepseek"];
      const modelName = selectedModel.toLowerCase();
      const isPremiumModel = premiumModels.some(pm => modelName.includes(pm));
      
      console.log(`Selected model: ${selectedModel}, Premium: ${isPremiumModel}, User subscribed: ${isSubscribed}`);
      
      if (isPremiumModel && !isSubscribed) {
        console.log("🚫 Premium model requested by non-subscriber");
        return res.status(403).json({ error: "Model not available for free users. Please subscribe to access this model." });
      }
      
      // Declare botReply variable to store response
      let botReply;
      
      try {
        // Process image attachments for all models
        let messages = [...conversationHistory]; // Clone the conversation history
        
        if (imageFiles.length > 0) {
          console.log(`Processing ${imageFiles.length} images for model: ${selectedModel}`);
          
          try {
            // For Claude models
            if (selectedModel.includes("claude")) {
              console.log("Preparing images for Claude");
              const imageContents = await prepareImagesForModel(imageFiles, "claude");
              const validImageContents = imageContents.filter(item => item !== null);
              
              console.log(`Valid Claude image contents: ${validImageContents.length}`);
              
              if (validImageContents.length > 0) {
                const promptText = userContent || "Please analyze these images and provide insights:";
                
                const imageMessage = {
                  role: "user",
                  content: [
                    { type: "text", text: promptText },
                    ...validImageContents
                  ]
                };
                
                // Replace the text-only message
                messages = messages.slice(0, -1); // Remove the last message (user text-only)
                messages.push(imageMessage); // Add the multimodal message
                
                console.log("Added Claude-formatted image message with", validImageContents.length, "images");
              }
            }
            // For OpenAI models
            else if (!selectedModel.includes("gemini") && !selectedModel.includes("grok")) {
              console.log("Preparing images for OpenAI");
              const imageContents = await prepareImagesForModel(imageFiles, "openai");
              const validImageContents = imageContents.filter(item => item !== null);
              
              console.log(`Valid OpenAI image contents: ${validImageContents.length}`);
              
              if (validImageContents.length > 0) {
                const promptText = userContent || "Please analyze these images and provide insights:";
                
                const imageMessage = {
                  role: "user",
                  content: [
                    { type: "text", text: promptText },
                    ...validImageContents
                  ]
                };
                
                // Replace the text-only message
                messages = messages.slice(0, -1); // Remove the last message (user text-only)
                messages.push(imageMessage); // Add the multimodal message
                
                console.log("Added OpenAI-formatted image message with", validImageContents.length, "images");
              }
            }
            // For Grok models
            else if (selectedModel.includes("grok")) {
              console.log("Preparing images for Grok");
              const imageContents = await prepareImagesForModel(imageFiles, "grok");
              const validImageContents = imageContents.filter(item => item !== null);
              
              console.log(`Valid Grok image contents: ${validImageContents.length}`);
              
              if (validImageContents.length > 0) {
                const promptText = userContent || "Please analyze these images and provide insights:";
                
                const imageMessage = {
                  role: "user",
                  content: [
                    { type: "text", text: promptText },
                    ...validImageContents
                  ]
                };
                
                // Replace the text-only message
                messages = messages.slice(0, -1); // Remove the last message (user text-only)
                messages.push(imageMessage); // Add the multimodal message
                
                console.log("Added Grok-formatted image message with", validImageContents.length, "images");
              }
            }
          } catch (imgProcessError) {
            console.error("Error processing images:", imgProcessError);
            return res.status(500).json({ error: "Error processing images: " + imgProcessError.message });
          }
        }
        
        // Handle different model types
        if (selectedModel.includes("gemini")) {
          // ** Handle Google Gemini API **
          // For Gemini, we handle images differently, passing them directly
          botReply = await generateGeminiResponse(userContent, selectedModel, imageFiles);
        } 
        else if (selectedModel.includes("claude")) {
          // ** Handle Claude API **
          botReply = await generateClaudeResponse(messages, selectedModel);
        }
        else if (selectedModel.includes("grok")) {
          // ** Handle Grok API **
          botReply = await generateGrokResponse(messages, selectedModel);
        }
        else {
          // ** Handle OpenAI API (default) **
          botReply = await generateOpenAIResponse(messages, selectedModel);
        }
        
        // Update conversation history with assistant response
        conversationHistory.push({ role: "assistant", content: botReply });
        
        // Save chat to database
        try {
          if (!existingChat) {
            const chatMessages = [
              { role: "user", content: userContent },
              { role: "assistant", content: botReply }
            ];
            await supabase.from('chats').insert({
              id: sessionId,
              user_id: data.user.id,
              messages: chatMessages,
              message_count: 1
            });
          } else {
            const updatedMessages = existingChat.messages ? [...existingChat.messages] : [];
            updatedMessages.push({ role: "user", content: userContent });
            updatedMessages.push({ role: "assistant", content: botReply });
            await supabase.from('chats').update({
              messages: updatedMessages,
              message_count: (existingChat.message_count || 0) + 1
            }).eq('id', sessionId);
          }
        } catch (err) {
          console.error("Error saving chat to database:", err);
        }
        
        // Send response
        return res.json({ reply: botReply });
      } catch (error) {
        console.error("API Error:", error);
        return res.status(500).json({ error: `${selectedModel} API error: ${error.message}` });
      }
    } catch (err) {
      console.error("🚨 Exception in auth:", err);
      return res.status(500).json({ error: "Authentication error" });
    }
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

// ** Streaming Chat API Endpoint (server-sent events) **
app.post("/api/chat/stream", enhancedUpload, async (req, res) => {
    console.log("📥 Received Streaming Request");

    // Add this at the start of your streaming endpoint:
    console.log("Headers received:", Object.keys(req.headers));
    console.log("Content-Type:", req.headers['content-type']);
    console.log("Auth header type:", typeof req.headers.authorization);

    try {
        const { sessionId, message, model } = req.body;
        console.log(`Request body: sessionId=${sessionId}, model=${model}, message=${message?.substring(0, 50)}`);
        console.log(`Files attached: ${req.files?.length || 0}`);
        
        if (!sessionId) {
            console.error("🚨 ERROR: Missing sessionId!");
            return res.status(400).json({ error: "Session ID is required." });
        }
        
        // More flexible validation - allow empty message if files are present
        const hasMessage = !!message && message.trim() !== '';
        const hasFiles = req.files && req.files.length > 0;
        
        if (!hasMessage && !hasFiles) {
            console.error("🚨 ERROR: No message or files provided!");
            return res.status(400).json({ error: "Message or files are required." });
        }
        
        // ** Authenticate user **
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            console.error("🚨 ERROR: Missing Authorization header!");
            return res.status(401).json({ error: "Missing Authorization header" });
        }

        // Log the token format to debug
        console.log("Auth header format:", authHeader.substring(0, 15) + "...");
        
        const token = authHeader.split(' ')[1];
        if (!token) {
            console.error("🚨 ERROR: Malformed Authorization header!");
            return res.status(401).json({ error: "Malformed Authorization header" });
        }
        
        // Set up SSE headers early to prevent header errors after async operations
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // CORS headers for SSE
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
        
        try {
            const { data, error: authError } = await supabase.auth.getUser(token);
            
            if (authError) {
                console.error("🚨 AUTH ERROR:", authError.message);
                res.write(`data: ${JSON.stringify({ error: "Authentication failed: " + authError.message })}\n\n`);
                return res.end();
            }
            
            if (!data.user) {
                console.error("🚨 ERROR: No user found for token");
                res.write(`data: ${JSON.stringify({ error: "No user found for this token" })}\n\n`);
                return res.end();
            }
            
            console.log("✅ Authenticated user:", data.user.email);
            
            // Check subscription status with improved helper
            const isSubscribed = await isUserSubscribed(data.user.id);
            console.log(`User ${data.user.email} subscription status (streaming):`, isSubscribed);
            
            // Check existing chat and enforce limits for free users
            const { data: existingChat } = await supabase.from('chats').select('messages, message_count').eq('id', sessionId).eq('user_id', data.user.id).maybeSingle();
            if (!isSubscribed) {
                if (!existingChat) {
                    const { count: totalChats } = await supabase.from('chats').select('*', { count: 'exact', head: true }).eq('user_id', data.user.id);
                    if (totalChats >= 3) {
                        res.write(`data: ${JSON.stringify({ error: "Free tier limit reached: Maximum 3 chats allowed." })}\n\n`);
                        return res.end();
                    }
                } else if (existingChat.message_count >= 20) {
                    res.write(`data: ${JSON.stringify({ error: "Free tier limit: Maximum 20 messages per chat reached." })}\n\n`);
                    return res.end();
                }
            }
            
            // Process any uploaded files for this message
            let uploadedFiles = [];
            if (req.files && req.files.length > 0) {
                try {
                    // Enhanced error handling for file processing
                    uploadedFiles = processUploadedFiles(req.files, sessionId, sessionFiles);
                    console.log(`📁 Processed ${uploadedFiles.length} files for session ${sessionId}`);
                    
                    if (uploadedFiles.length !== req.files.length) {
                        console.warn(`⚠️ Warning: Only ${uploadedFiles.length} out of ${req.files.length} files were processed`);
                    }
                } catch (fileError) {
                    console.error("❌ Error processing uploaded files:", fileError);
                    res.write(`data: ${JSON.stringify({ error: "Error processing uploaded files: " + fileError.message })}\n\n`);
                    return res.end();
                }
            }
            
            // Initialize conversation in memory if needed
            if (!userConversations.has(sessionId)) {
                userConversations.set(sessionId, [{ role: "system", content: "You are PantherAI, a helpful assistant." }]);
                userSelectedModel.set(sessionId, model || "gpt-3.5-turbo");
            }
            
            let selectedModel = userSelectedModel.get(sessionId) || "gpt-3.5-turbo";
            if (model) selectedModel = model;
            userSelectedModel.set(sessionId, selectedModel);
            
            // ** Start of model handling code **
            const premiumModels = ["gpt-4", "claude", "grok", "deepseek"];
            const modelName = selectedModel.toLowerCase();
            const isPremiumModel = premiumModels.some(pm => modelName.includes(pm));

            console.log(`Streaming - Selected model: ${selectedModel}, Premium: ${isPremiumModel}, User subscribed: ${isSubscribed}`);

            if (isPremiumModel && !isSubscribed) {
                console.log("🚫 Premium model requested by non-subscriber (streaming)");
                // Immediately terminate stream with error message
                res.write(`data: ${JSON.stringify({ error: "Model not available for free users. Please subscribe to access this model." })}\n\n`);
                return res.end();
            }

            try {
                let messages = [];
                // Build message history for API
                messages.push({
                    role: "system",
                    content: "You are PantherAI, a helpful assistant that can analyze various types of documents and images to help users."
                });
                
                const conversationHistory = userConversations.get(sessionId);
                if (conversationHistory && conversationHistory.length > 1) {
                    for (let i = 1; i < conversationHistory.length; i++) {
                        messages.push(conversationHistory[i]);
                    }
                }
                
                // Handle new user message and attached files
                let imageFiles = [];
                let textFiles = [];
                
                if (req.files && req.files.length > 0) {
                    // Better classification of files with error handling
                    try {
                        imageFiles = req.files.filter(f => f.mimetype && f.mimetype.startsWith('image/'));
                        textFiles = req.files.filter(f => f.mimetype && !f.mimetype.startsWith('image/'));
                        
                        console.log(`Classified files: ${imageFiles.length} images, ${textFiles.length} text/documents`);
                    } catch (fileClassifyError) {
                        console.error("Error classifying files:", fileClassifyError);
                        imageFiles = [];
                        textFiles = [];
                    }
                }
                
                // Process text file attachments (include their content in the prompt)
                let textFilesContent = "";
                if (textFiles.length > 0) {
                    try {
                        const textFilesInfo = await Promise.all(textFiles.map(async (file) => {
                            let fileInfo = `- ${file.originalname} (${file.mimetype}, ${(file.size / 1024).toFixed(2)} KB)`;
                            if (file.mimetype && (file.mimetype.startsWith('text/') || file.mimetype.includes('json') || file.mimetype.includes('csv'))) {
                                try {
                                    const fileContent = await readFileContent(file.path);
                                    if (fileContent) {
                                        fileInfo += `\n\nContent of ${file.originalname}:\n\`\`\`\n${fileContent}\n\`\`\``;
                                    }
                                } catch (err) {
                                    console.error(`Error reading text file ${file.path}:`, err);
                                }
                            } else {
                                fileInfo += "\n[Binary file]";
                            }
                            return fileInfo;
                        }));
                        
                        if (textFilesInfo.length > 0) {
                            textFilesContent = `I've attached the following text-based files:\n${textFilesInfo.join('\n\n')}\n\n`;
                        }
                    } catch (textFileError) {
                        console.error("Error processing text files:", textFileError);
                        // Continue without text file content
                        textFilesContent = "I've attached some text files, but they couldn't be processed properly.";
                    }
                }
                
                // Append the user's text (and text file content if any) to the conversation
                let userContent = message || '';
                if (textFilesContent) {
                    userContent += userContent ? '\n\n' : '';
                    userContent += textFilesContent;
                }
                
                // Ensure we have valid user content
                if (!userContent && imageFiles.length === 0) {
                    userContent = "Please analyze the attached files.";
                }
                
                if (userContent) {
                    messages.push({ role: "user", content: userContent });
                }
                
                // Process image attachments for all models
                if (imageFiles.length > 0) {
                    console.log(`Processing ${imageFiles.length} images for model: ${selectedModel}`);
                    
                    try {
                        // For Claude models
                        if (selectedModel.includes("claude")) {
                            console.log("Preparing images for Claude");
                            const imageContents = await prepareImagesForModel(imageFiles, "claude");
                            const validImageContents = imageContents.filter(item => item !== null);
                            
                            console.log(`Valid Claude image contents: ${validImageContents.length}`);
                            
                            if (validImageContents.length > 0) {
                                const promptText = userContent || "Please analyze these images and provide insights:";
                                
                                const imageMessage = {
                                    role: "user",
                                    content: [
                                        { type: "text", text: promptText },
                                        ...validImageContents
                                    ]
                                };
                                
                                // Replace the text-only message with the multimodal message
                                if (messages.length > 0 && messages[messages.length - 1].role === "user") {
                                    messages.pop(); // Remove the text-only message
                                }
                                
                                messages.push(imageMessage);
                                console.log("Added Claude-formatted image message with", validImageContents.length, "images");
                            } else {
                                console.error("❌ Failed to process any images for Claude");
                                res.write(`data: ${JSON.stringify({ error: "Failed to process image attachments for Claude" })}\n\n`);
                                return res.end();
                            }
                        }
                        // For OpenAI models
                        else if (!selectedModel.includes("gemini") && !selectedModel.includes("grok")) {
                            console.log("Preparing images for OpenAI");
                            const imageContents = await prepareImagesForModel(imageFiles, "openai");
                            const validImageContents = imageContents.filter(item => item !== null);
                            
                            console.log(`Valid OpenAI image contents: ${validImageContents.length}`);
                            
                            if (validImageContents.length > 0) {
                                const promptText = userContent || "Please analyze these images and provide insights:";
                                
                                const imageMessage = {
                                    role: "user",
                                    content: [
                                        { type: "text", text: promptText },
                                        ...validImageContents
                                    ]
                                };
                                
                                // Replace the text-only message with the multimodal message
                                if (messages.length > 0 && messages[messages.length - 1].role === "user") {
                                    messages.pop(); // Remove the text-only message
                                }
                                
                                messages.push(imageMessage);
                                console.log("Added OpenAI-formatted image message with", validImageContents.length, "images");
                            } else {
                                console.error("❌ Failed to process any images for OpenAI");
                                res.write(`data: ${JSON.stringify({ error: "Failed to process image attachments for OpenAI" })}\n\n`);
                                return res.end();
                            }
                        }
                        // For Grok models
                        else if (selectedModel.includes("grok")) {
                            console.log("Preparing images for Grok");
                            const imageContents = await prepareImagesForModel(imageFiles, "grok");
                            const validImageContents = imageContents.filter(item => item !== null);
                            
                            console.log(`Valid Grok image contents: ${validImageContents.length}`);
                            
                            if (validImageContents.length > 0) {
                                const promptText = userContent || "Please analyze these images and provide insights:";
                                
                                const imageMessage = {
                                    role: "user",
                                    content: [
                                        { type: "text", text: promptText },
                                        ...validImageContents
                                    ]
                                };
                                
                                // Replace the text-only message with the multimodal message
                                if (messages.length > 0 && messages[messages.length - 1].role === "user") {
                                    messages.pop(); // Remove the text-only message
                                }
                                
                                messages.push(imageMessage);
                                console.log("Added Grok-formatted image message with", validImageContents.length, "images");
                            } else {
                                console.error("❌ Failed to process any images for Grok");
                                res.write(`data: ${JSON.stringify({ error: "Failed to process image attachments for Grok" })}\n\n`);
                                return res.end();
                            }
                        }
                        // For Gemini models - handled separately when calling the service
                        else if (selectedModel.includes("gemini")) {
                            console.log("Images for Gemini will be handled by the Gemini service directly");
                        }
                    } catch (imgProcessError) {
                        console.error("Error processing images:", imgProcessError);
                        res.write(`data: ${JSON.stringify({ error: "Error processing images: " + imgProcessError.message })}\n\n`);
                        return res.end();
                    }
                }
                
                // Create a function to handle saving completed chats
                const saveCompletedChat = async (completeResponse) => {
                    // Update conversation history in memory
                    if (userContent && !conversationHistory.some(msg => msg.role === "user" && msg.content === userContent)) {
                        conversationHistory.push({ role: "user", content: userContent });
                    }
                    conversationHistory.push({ role: "assistant", content: completeResponse });
                    
                    // Save to database
                    try {
                        if (!existingChat) {
                            const chatMessages = [
                                { role: "user", content: userContent },
                                { role: "assistant", content: completeResponse }
                            ];
                            await supabase.from('chats').insert({
                                id: sessionId,
                                user_id: data.user.id,
                                messages: chatMessages,
                                message_count: 1
                            });
                        } else {
                            const updatedMessages = existingChat.messages ? [...existingChat.messages] : [];
                            updatedMessages.push({ role: "user", content: userContent });
                            updatedMessages.push({ role: "assistant", content: completeResponse });
                            await supabase.from('chats').update({
                                messages: updatedMessages,
                                message_count: (existingChat.message_count || 0) + 1
                            }).eq('id', sessionId);
                        }
                    } catch (err) {
                        console.error("Error saving chat to database:", err);
                    }
                };
                
                // ** Handle different model types with cleaner logic **
                if (selectedModel.includes("gemini")) {
                    // Gemini API (non-streaming but using SSE format)
                    try {
                        console.log("Calling Gemini service with", imageFiles.length, "images");
                        
                        // Safety check - make sure we have some content
                        const geminiUserContent = userContent || "Please analyze these images.";
                        
                        // Pass image files to Gemini service
                        const botReply = await handleGeminiStreamingRequest(res, geminiUserContent, selectedModel, imageFiles);
                        
                        // Update conversation history in memory
                        conversationHistory.push({ role: "user", content: userContent });
                        conversationHistory.push({ role: "assistant", content: botReply });
                        
                        // Save chat to database
                        try {
                            if (!existingChat) {
                                const chatMessages = [
                                    { role: "user", content: userContent },
                                    { role: "assistant", content: botReply }
                                ];
                                await supabase.from('chats').insert({
                                    id: sessionId,
                                    user_id: data.user.id,
                                    messages: chatMessages,
                                    message_count: 1
                                });
                            } else {
                                const updatedMessages = existingChat.messages ? [...existingChat.messages] : [];
                                updatedMessages.push({ role: "user", content: userContent });
                                updatedMessages.push({ role: "assistant", content: botReply });
                                await supabase.from('chats').update({
                                    messages: updatedMessages,
                                    message_count: (existingChat.message_count || 0) + 1
                                }).eq('id', sessionId);
                            }
                        } catch (err) {
                            console.error("Error saving chat to database:", err);
                        }
                        
                        return; // Already sent done message in handleGeminiStreamingRequest
                    } catch (error) {
                        console.error("Gemini API Error:", error);
                        // Error already handled in handleGeminiStreamingRequest
                        return;
                    }
                } 
                else if (selectedModel.includes("claude")) {
                    // Claude API (streaming)
                    try {
                        console.log("Calling Claude streaming with message count:", messages.length);
                        await generateClaudeStreamingResponse(res, messages, selectedModel, saveCompletedChat);
                        return; // Already sent done message in streaming function
                    } catch (error) {
                        console.error("Claude API Error:", error);
                        // Error already handled in streaming function
                        return;
                    }
                } 
                else if (selectedModel.includes("grok")) {
                    // Grok API (streaming)
                    try {
                        console.log("Calling Grok streaming with message count:", messages.length);
                        await generateGrokStreamingResponse(res, messages, selectedModel, saveCompletedChat);
                        return; // Already sent done message in streaming function
                    } catch (error) {
                        console.error("Grok API Error:", error);
                        // Error already handled in streaming function
                        return;
                    }
                } 
                else {
                    // OpenAI API (streaming) - default
                    console.log("Calling OpenAI streaming with message count:", messages.length);
                    await generateOpenAIStreamingResponse(res, messages, selectedModel, saveCompletedChat);
                }
                
                // Note: we don't need to end the stream here as it's handled inside the streaming functions
            } catch (error) {
                console.error("❌ API Streaming Error:", error);
                res.write(`data: ${JSON.stringify({ error: "Failed to generate AI response", details: error.message })}\n\n`);
                res.end();
            }
        } catch (err) {
            console.error("🚨 Exception in auth:", err);
            res.write(`data: ${JSON.stringify({ error: "Authentication error", details: err.message })}\n\n`);
            res.end();
        }
    } catch (error) {
        console.error("❌ Server Streaming Error:", error);
        res.write(`data: ${JSON.stringify({ error: "Internal server error", details: error.message })}\n\n`);
        res.end();
    }
});

// Add route for the main application
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../chatbot/index.html'));
});

// Health check endpoint
app.get("/api/health", (req, res) => {
    res.json({
        status: "healthy",
        apiKey: OPENAI_API_KEY ? "configured" : "missing",
        time: new Date().toISOString()
    });
});

// Debug endpoint to check auth token
app.get("/api/auth-check", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.json({ 
            status: "no-auth-header",
            message: "No authorization header provided"
        });
    }
    
    try {
        const token = authHeader.split(' ')[1];
        const { data, error } = await supabase.auth.getUser(token);
        
        if (error) {
            return res.json({
                status: "auth-error",
                message: error.message,
                details: error
            });
        }
        
        if (data.user) {
            // Check subscription status
            const isSubscribed = await isUserSubscribed(data.user.id);
            return res.json({
                status: "authenticated",
                user: {
                    id: data.user.id,
                    email: data.user.email,
                    isSubscribed: isSubscribed
                }
            });
        } else {
            return res.json({
                status: "no-user",
                message: "Token valid but no user found"
            });
        }
    } catch (err) {
        return res.json({
            status: "exception",
            message: err.message
        });
    }
});

// Delete Chat Endpoint
app.delete("/api/chat/:sessionId", async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) {
        return res.status(400).json({ error: "Chat ID is required." });
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }
    
    console.log("Delete chat - Auth header:", authHeader.substring(0, 15) + "...");
    
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Malformed Authorization header" });
    }
    
    try {
        const { data, error: authError } = await supabase.auth.getUser(token);
        
        if (authError) {
            console.error("DELETE AUTH ERROR:", authError.message);
            return res.status(401).json({ error: "Authentication failed: " + authError.message });
        }
        
        if (!data.user) {
            return res.status(401).json({ error: "No user found for this token" });
        }
        
        try {
            const { error: deleteError } = await supabase.from('chats').delete().eq('id', sessionId).eq('user_id', data.user.id);
            if (deleteError) {
                console.error("Error deleting chat:", deleteError);
                return res.status(500).json({ error: "Failed to delete chat." });
            }
            
            // Remove in-memory data for this session
            sessionFiles.delete(sessionId);
            userConversations.delete(sessionId);
            userSelectedModel.delete(sessionId);
            res.json({ success: true });
        } catch (err) {
            console.error("Error deleting chat:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    } catch (err) {
        console.error("Exception in delete auth:", err);
        return res.status(500).json({ error: "Authentication error" });
    }
});

// Stripe Checkout Session Endpoint
app.post("/api/create-checkout-session", express.json(), async (req, res) => {
    console.log("💰 Create checkout session request received");
    
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        console.error("Missing Authorization header in checkout request");
        return res.status(401).json({ error: "Missing Authorization header" });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
        console.error("Malformed Authorization header in checkout request");
        return res.status(401).json({ error: "Malformed Authorization header" });
    }
    
    console.log("Creating checkout with token starting with:", token.substring(0, 10) + "...");
    
    try {
        const { data, error: authError } = await supabase.auth.getUser(token);
        
        if (authError) {
            console.error("Auth error in checkout:", authError.message);
            return res.status(401).json({ error: "Authentication failed: " + authError.message });
        }
        
        if (!data.user) {
            console.error("No user found for token in checkout");
            return res.status(401).json({ error: "No user found for this token" });
        }
        
        console.log("✅ Creating checkout for user:", data.user.email);
        
        try {
            // Check subscription status with improved helper
            const isSubscribed = await isUserSubscribed(data.user.id);
            
            // If already subscribed, prevent duplicate checkout
            if (isSubscribed) {
                console.log("User already subscribed:", data.user.id);
                return res.status(400).json({ error: "You already have an active subscription." });
            }
            
            // Ensure user record exists
            const { data: userRecord } = await supabase
                .from('users')
                .select('id')
                .eq('id', data.user.id)
                .maybeSingle();
                
            if (!userRecord) {
                console.log("Creating user record for checkout...");
                await supabase.from('users').insert({
                    id: data.user.id,
                    email: data.user.email,
                    is_subscribed: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            }
            
            // Make sure STRIPE_PRICE_ID is set
            if (!process.env.STRIPE_PRICE_ID) {
                console.error("STRIPE_PRICE_ID not configured");
                return res.status(500).json({ error: "Subscription service not properly configured. Please contact support." });
            }
            
            // Create the checkout session with improved metadata
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                mode: 'subscription',
                line_items: [{ 
                    price: process.env.STRIPE_PRICE_ID, 
                    quantity: 1 
                }],
                success_url: `${req.headers.origin || 'http://localhost:5050'}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${req.headers.origin || 'http://localhost:5050'}/?checkout=cancel`,
                customer_email: data.user.email,
                client_reference_id: data.user.id,
                subscription_data: {
                    metadata: { supabase_user_id: data.user.id }
                },
                metadata: { 
                    supabase_user_id: data.user.id,
                    user_email: data.user.email 
                }
            });
            
            console.log("✅ Checkout session created:", session.id);
            res.json({ url: session.url });
        } catch (error) {
            console.error("Stripe checkout error:", error);
            res.status(500).json({ error: "Unable to create checkout session: " + error.message });
        }
    } catch (err) {
        console.error("Exception in checkout auth:", err);
        return res.status(500).json({ error: "Authentication error: " + err.message });
    }
});

// Stripe Webhook Endpoint (listen for subscription events)
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    
    console.log("Webhook received! Signature:", sig ? "Present" : "Missing");
    
    try {
        // Verify webhook signature
        event = stripe.webhooks.constructEvent(
            req.body, 
            sig, 
            STRIPE_WEBHOOK_SECRET
        );
        console.log("✅ Webhook signature verified. Event type:", event.type);
    } catch (err) {
        console.error("⚠️ Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log("📣 Processing Stripe webhook:", event.type);
    
    try {
        // Handle checkout.session.completed event
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            console.log("Checkout completed. Mode:", session.mode);
            
            // Make sure it's a subscription checkout
            if (session.mode === 'subscription') {
                // Get the user ID from metadata or client_reference_id
                const userId = session.metadata?.supabase_user_id || session.client_reference_id;
                const userEmail = session.metadata?.user_email || session.customer_email;
                
                console.log(`Webhook: Processing subscription for user ID: ${userId}, email: ${userEmail}`);
                
                if (userId) {
                    // First check if user record exists
                    const { data: existingUser } = await supabase
                        .from('users')
                        .select('id')
                        .eq('id', userId)
                        .maybeSingle();
                        
                    if (!existingUser) {
                        console.log(`User record doesn't exist for ID ${userId}, creating one...`);
                        // Create user record if it doesn't exist
                        await supabase
                            .from('users')
                            .insert({
                                id: userId,
                                email: userEmail,
                                is_subscribed: true,
                                stripe_customer_id: session.customer,
                                stripe_subscription_id: session.subscription,
                                created_at: new Date().toISOString(),
                                updated_at: new Date().toISOString()
                            });
                    } else {
                        console.log(`Updating existing user ${userId} with subscription data`);
                        // Update existing user record
                        const { error } = await supabase
                            .from('users')
                            .update({ 
                                is_subscribed: true,
                                stripe_customer_id: session.customer,
                                stripe_subscription_id: session.subscription,
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', userId);
                        
                        if (error) {
                            console.error("Failed to update user subscription status:", error);
                        } else {
                            console.log(`✅ User ${userId} subscription activated successfully`);
                        }
                    }
                } else {
                    console.error("No user ID found in session metadata or client_reference_id");
                }
            }
        } 
        // Handle subscription updated or deleted events
        else if (event.type === 'customer.subscription.updated' || 
                 event.type === 'customer.subscription.deleted') {
            
            const subscription = event.data.object;
            
            // First try to get user ID from metadata
            let userId = subscription.metadata?.supabase_user_id;
            
            // If not found in metadata, look up user by customer ID
            if (!userId) {
                const { data: userData } = await supabase
                    .from('users')
                    .select('id')
                    .eq('stripe_customer_id', subscription.customer)
                    .single();
                
                if (userData) {
                    userId = userData.id;
                }
            }
            
            if (userId) {
                // Update subscription status based on Stripe status
                const isSubscribed = 
                    subscription.status === 'active' || 
                    subscription.status === 'trialing';
                
                const { error } = await supabase
                    .from('users')
                    .update({ 
                        is_subscribed: isSubscribed,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', userId);
                
                if (error) {
                    console.error("Failed to update subscription status:", error);
                } else {
                    console.log(`User ${userId} subscription status updated to: ${isSubscribed ? 'active' : 'inactive'}`);
                }
            } else {
                console.error("Could not find user for subscription:", subscription.id);
            }
        }
    } catch (err) {
        console.error("Error processing webhook event:", err);
        // Still return 200 to acknowledge receipt (to prevent Stripe from retrying)
    }
    
    // Return 200 success response to acknowledge receipt of the event
    res.status(200).json({ received: true });
});

// Manual subscription check endpoint (for debugging)
app.get("/api/subscription-check", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Malformed Authorization header" });
    }
    
    try {
        const { data, error: authError } = await supabase.auth.getUser(token);
        
        if (authError) {
            return res.status(401).json({ error: "Authentication failed: " + authError.message });
        }
        
        if (!data.user) {
            return res.status(401).json({ error: "No user found for this token" });
        }
        
        // Use our improved subscription check method
        const isSubscribed = await isUserSubscribed(data.user.id);
        
        // Get full data for diagnostics
        const { data: profile, error } = await supabase
            .from('users')
            .select('is_subscribed, stripe_customer_id, stripe_subscription_id, updated_at')
            .eq('id', data.user.id)
            .single();
        
        // If Stripe ID exists, check Stripe status directly
        if (profile?.stripe_subscription_id) {
            try {
                const subscription = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
                const stripeStatus = subscription.status;
                
                return res.json({ 
                    isSubscribed: isSubscribed,
                    dbValue: profile?.is_subscribed || false,
                    stripeStatus: stripeStatus,
                    stripeSubscriptionId: profile.stripe_subscription_id,
                    stripeCustomerId: profile.stripe_customer_id,
                    lastUpdated: profile.updated_at
                });
            } catch (stripeErr) {
                console.error("Error checking Stripe subscription:", stripeErr);
                // Fall back to computed status
                return res.json({ 
                    isSubscribed: isSubscribed,
                    dbValue: profile?.is_subscribed || false,
                    note: "Could not verify with Stripe directly",
                    stripeError: stripeErr.message,
                    lastUpdated: profile?.updated_at
                });
            }
        } else {
            return res.json({ 
                isSubscribed: isSubscribed,
                dbValue: profile?.is_subscribed || false,
                note: "No Stripe subscription ID found",
                lastUpdated: profile?.updated_at || "unknown"
            });
        }
    } catch (err) {
        console.error("Exception in subscription check:", err);
        return res.status(500).json({ error: "Server error checking subscription", details: err.message });
    }
});

// Force update subscription status endpoint
app.get("/api/force-subscription-update", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Malformed Authorization header" });
    }
    
    try {
        const { data, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !data.user) {
            return res.status(401).json({ error: "Authentication failed" });
        }
        
        // Check if user record exists
        const { data: userRecord } = await supabase
            .from('users')
            .select('id')
            .eq('id', data.user.id)
            .maybeSingle();
            
        if (!userRecord) {
            // Create user record if it doesn't exist
            await supabase.from('users').insert({
                id: data.user.id,
                email: data.user.email,
                is_subscribed: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        } else {
            // Force set subscription to true
            await supabase
                .from('users')
                .update({ 
                    is_subscribed: true,
                    updated_at: new Date().toISOString()
                })
                .eq('id', data.user.id);
        }
        
        return res.json({ 
            success: true, 
            message: "Subscription status forcibly updated to active",
            userId: data.user.id
        });
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: "Server error", details: err.message });
    }
});

// Debug endpoint to check and fix database issues
app.get("/api/fix-db", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }
    
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Malformed Authorization header" });
    }
    
    try {
        // Get user from token
        const { data, error: authError } = await supabase.auth.getUser(token);
        if (authError || !data.user) {
            return res.status(401).json({ error: "Authentication failed" });
        }
        
        // Check if users table exists
        const { error: tableCheckError } = await supabase.from('users').select('count').limit(1);
        if (tableCheckError) {
            console.error("Table check error:", tableCheckError.message);
            return res.status(500).json({
                error: "Database structure issue",
                details: "The users table appears to be missing or inaccessible",
                resolution: "Please check your Supabase database structure"
            });
        }
        
        // Table exists, check if user record exists
        const { data: userData, error: userCheckError } = await supabase
            .from('users')
            .select('*')
            .eq('id', data.user.id)
            .maybeSingle();
            
        if (userCheckError) {
            console.error("User check error:", userCheckError.message);
            return res.status(500).json({ error: "Error checking user record" });
        }
        
        if (!userData) {
            // User record doesn't exist, create it
            console.log("Creating user record...");
            const { error: insertError } = await supabase
                .from('users')
                .insert({
                    id: data.user.id,
                    email: data.user.email,
                    is_subscribed: true, // Force set as subscriber
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
                
            if (insertError) {
                console.error("Insert error:", insertError.message);
                return res.status(500).json({ error: "Failed to create user record" });
            }
            
            return res.json({
                success: true,
                action: "created_user",
                message: "Created new user record with premium access"
            });
        } else {
            // User exists, update subscription status
            console.log("Updating existing user...");
            const { error: updateError } = await supabase
                .from('users')
                .update({
                    is_subscribed: true,
                    updated_at: new Date().toISOString()
                })
                .eq('id', data.user.id);
                
            if (updateError) {
                console.error("Update error:", updateError.message);
                return res.status(500).json({ error: "Failed to update subscription status" });
            }
            
            return res.json({
                success: true,
                action: "updated_user",
                message: "Updated user to premium status",
                user: {
                    id: data.user.id,
                    email: data.user.email,
                    isSubscribed: true
                }
            });
        }
    } catch (err) {
        console.error("Fix DB error:", err);
        return res.status(500).json({ error: "Server error: " + err.message });
    }
});

// API tests for various models
app.get("/api/test-gemini-direct", async (req, res) => {
    try {
      const testResult = await testGeminiConnection();
      return res.json(testResult);
    } catch (err) {
      console.error("Error testing Gemini:", err);
      return res.status(500).json({ error: err.message });
    }
});

// Test Claude connection
app.get("/api/test-claude-direct", async (req, res) => {
    try {
      const testResult = await testClaudeConnection();
      return res.json(testResult);
    } catch (err) {
      console.error("Error testing Claude:", err);
      return res.status(500).json({ error: err.message });
    }
  });
  
  // Test Grok connection
  app.get("/api/test-grok-direct", async (req, res) => {
    try {
      const testResult = await testGrokConnection();
      return res.json(testResult);
    } catch (err) {
      console.error("Error testing Grok:", err);
      return res.status(500).json({ error: err.message });
    }
  });

// Database repair endpoint (for emergency fixes)
app.post("/api/admin/repair-database", express.json(), async (req, res) => {
    // For admin use only - proper authentication would be needed in production
    try {
        const { userId } = req.body;
        
        if (!userId) {
            // Scan all users
            const { data: users, error: usersError } = await supabase
                .from('users')
                .select('id, email, is_subscribed, stripe_customer_id, stripe_subscription_id')
                .limit(100); // Limit to avoid overload
                
            if (usersError) {
                return res.status(500).json({ error: "Failed to fetch users", details: usersError.message });
            }
            
            const updates = [];
            
            // Check each user with a Stripe subscription ID
            for (const user of users) {
                if (user.stripe_subscription_id) {
                    try {
                        const subscription = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
                        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
                        
                        // If mismatch, update
                        if (user.is_subscribed !== isActive) {
                            const { error } = await supabase
                                .from('users')
                                .update({ 
                                    is_subscribed: isActive,
                                    updated_at: new Date().toISOString()
                                })
                                .eq('id', user.id);
                                
                            updates.push({
                                userId: user.id,
                                email: user.email,
                                oldStatus: user.is_subscribed,
                                newStatus: isActive,
                                error: error ? error.message : null
                            });
                        }
                    } catch (stripeErr) {
                        console.error(`Stripe error for user ${user.id}:`, stripeErr);
                        updates.push({
                            userId: user.id,
                            email: user.email,
                            error: stripeErr.message
                        });
                    }
                }
            }
            
            return res.json({
                success: true,
                message: `Checked ${users.length} users, made ${updates.length} updates`,
                updates
            });
        } else {
            // Fix a specific user
            const { data: user, error: userError } = await supabase
                .from('users')
                .select('id, email, is_subscribed, stripe_customer_id, stripe_subscription_id')
                .eq('id', userId)
                .single();
                
            if (userError || !user) {
                return res.status(404).json({ error: "User not found", details: userError?.message });
            }
            
            // Force set is_subscribed to true
            const { error } = await supabase
                .from('users')
                .update({ 
                    is_subscribed: true,
                    updated_at: new Date().toISOString()
                })
                .eq('id', userId);
                
            return res.json({
                success: !error,
                message: error ? `Failed to update user: ${error.message}` : `User ${user.email} subscription enabled`,
                user: { ...user, is_subscribed: true }
            });
        }
    } catch (err) {
        console.error("Database repair error:", err);
        return res.status(500).json({ error: "Server error", details: err.message });
    }
});

// Direct subscription debug endpoint to allow admin override
app.post("/api/admin/override-subscription", express.json(), async (req, res) => {
    // This is for debugging and development only - would need proper admin authentication in production
    try {
        const { userId, action } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }
        
        // Check if user exists
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('id, email, is_subscribed')
            .eq('id', userId)
            .maybeSingle();
            
        if (userError || !userData) {
            return res.status(404).json({ error: "User not found", details: userError?.message });
        }
        
        // Update subscription status based on action
        if (action === 'enable') {
            // Force enable subscription
            const { error } = await supabase
                .from('users')
                .update({ 
                    is_subscribed: true, 
                    updated_at: new Date().toISOString() 
                })
                .eq('id', userId);
                
            if (error) {
                return res.status(500).json({ error: "Failed to update subscription", details: error.message });
            }
            
            return res.json({
                success: true,
                message: `Subscription enabled for user ${userData.email} (${userId})`,
                user: { ...userData, is_subscribed: true }
            });
        } else if (action === 'disable') {
            // Force disable subscription
            const { error } = await supabase
                .from('users')
                .update({ 
                    is_subscribed: false, 
                    updated_at: new Date().toISOString() 
                })
                .eq('id', userId);
                
            if (error) {
                return res.status(500).json({ error: "Failed to update subscription", details: error.message });
            }
            
            return res.json({
                success: true,
                message: `Subscription disabled for user ${userData.email} (${userId})`,
                user: { ...userData, is_subscribed: false }
            });
        } else {
            return res.status(400).json({ error: "Invalid action. Use 'enable' or 'disable'." });
        }
    } catch (err) {
        console.error("Admin override error:", err);
        return res.status(500).json({ error: "Server error", details: err.message });
    }
});

// For Vercel serverless deployment
export default function(req, res) {
    return app(req, res);
  }
  
  // Start server only in non-Vercel environments
  if (!process.env.VERCEL) {
    const PORT = config.port;
    app.listen(PORT, () => console.log(`🔥 Server running on port ${PORT}`));
  }