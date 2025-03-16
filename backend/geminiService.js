import config from './config/env.js';
import fs from 'fs';

// Get API key from config
const GEMINI_API_KEY = config.gemini.apiKey;

// Updated Gemini model mapping to use the latest models
const GEMINI_MODEL_MAPPING = {
  'gemini-pro': 'gemini-pro',
  'gemini-pro-vision': 'gemini-pro-vision',
  'gemini-2.0-flash': 'gemini-2.0-flash', // Use the actual multimodal model
  'gemini-flash': 'gemini-2.0-flash',     // Alias for the 2.0-flash model
  'gemini-2.0-pro': 'gemini-2.0-pro'      // Use the actual model
};

/**
 * Checks if a valid Gemini API key is configured
 * @returns {boolean} True if API key is properly configured
 */
export function isGeminiConfigured() {
  return GEMINI_API_KEY && GEMINI_API_KEY !== "<YOUR_GEMINI_API_KEY>";
}

/**
 * Get the correct Gemini model name
 * @param {string} modelName - The model name from the UI
 * @returns {string} The current valid model name
 */
function getCurrentGeminiModel(modelName) {
  // Convert to a safe, known model name
  return GEMINI_MODEL_MAPPING[modelName] || 'gemini-pro';
}

/**
 * Process images for Gemini API
 * 
 * @param {Array} imageFiles - Array of image files
 * @returns {Promise<Array>} Array of formatted image objects for Gemini
 */
async function processImagesForGemini(imageFiles) {
  if (!imageFiles || imageFiles.length === 0) return [];
  
  try {
    return await Promise.all(imageFiles.map(async (file) => {
      try {
        console.log(`Processing Gemini image: ${file.path}`);
        // Read the file data
        const fileBuffer = await fs.promises.readFile(file.path);
        const base64Data = fileBuffer.toString('base64');
        
        // Return in Gemini's format
        return {
          inlineData: {
            data: base64Data,
            mimeType: file.mimetype
          }
        };
      } catch (error) {
        console.error(`Error processing image for Gemini: ${file.path}`, error);
        return null;
      }
    }));
  } catch (error) {
    console.error("Error processing images for Gemini:", error);
    return [];
  }
}

/**
 * Generates a response from the Gemini API (non-streaming)
 * 
 * @param {string} userContent - The user's message
 * @param {string} modelName - The Gemini model to use
 * @param {Array} imageFiles - Optional array of image files
 * @returns {Promise<string>} - Response text from Gemini
 */
export async function generateGeminiResponse(userContent, modelName, imageFiles = []) {
  const geminiModel = getCurrentGeminiModel(modelName);
  console.log(`🤖 Using Gemini model: ${geminiModel} (requested: ${modelName})`);
  
  // Check API key
  if (!isGeminiConfigured()) {
    console.error("🚨 Missing valid Gemini API key");
    throw new Error("Gemini API key not configured. Please contact administrator.");
  }
  
  try {
    // Log the request for debugging
    console.log("📤 Sending to Gemini API:", userContent?.substring(0, 100) + (userContent?.length > 100 ? "..." : ""));
    console.log(`📤 Image files to process: ${imageFiles?.length || 0}`);
    
    // Determine which model to use - use vision model if images are present
    const hasImages = imageFiles && imageFiles.length > 0;
    
    // For 2.0 models, we don't need to switch to vision-specific model
    // Only use gemini-pro-vision for the older generation if images are present
    let apiModel = geminiModel;
    if (hasImages && !geminiModel.includes('2.0') && !geminiModel.includes('gemini-pro-vision')) {
      apiModel = "gemini-pro-vision";
    }
    
    console.log(`Using Gemini API model: ${apiModel} (has images: ${hasImages})`);
    
    // IMPORTANT: Using the correct endpoint format
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${GEMINI_API_KEY}`;
    console.log(`Using Gemini API URL: ${geminiApiUrl}`);
    
    // Create the request payload
    const geminiPayload = {
      contents: [
        {
          parts: []
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024
      }
    };
    
    // Add user text if provided
    if (userContent) {
      geminiPayload.contents[0].parts.push({ text: userContent });
    }
    
    // Add images if provided
    if (hasImages) {
      const processedImages = await processImagesForGemini(imageFiles);
      const validImages = processedImages.filter(img => img !== null);
      
      if (validImages.length > 0) {
        // Add images to the parts array
        geminiPayload.contents[0].parts.push(...validImages);
        console.log(`Added ${validImages.length} images to Gemini request`);
      }
    }
    
    // Log payload for debugging
    console.log("Gemini payload structure:", 
                JSON.stringify({
                  model: apiModel,
                  contentParts: geminiPayload.contents[0].parts.length,
                  hasImages: hasImages
                }));
    
    // Send the request to Gemini API
    const geminiResponse = await fetch(geminiApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    });
    
    // Log response status
    console.log("Gemini API response status:", geminiResponse.status);
    
    // Handle non-200 responses
    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini API error:", errorText);
      throw new Error(`Gemini API responded with ${geminiResponse.status}: ${errorText}`);
    }
    
    // Parse the JSON response
    const geminiData = await geminiResponse.json();
    
    // Extract the text from the response with better error handling
    let botReply = "Error processing Gemini response.";
    
    if (geminiData?.candidates && geminiData.candidates.length > 0) {
      const candidate = geminiData.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        botReply = candidate.content.parts[0].text || botReply;
      }
    }
    
    return botReply;
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}

/**
 * Handles a streaming request for Gemini by simulating streaming
 * 
 * @param {object} res - Express response object for SSE
 * @param {string} userContent - User's message
 * @param {string} selectedModel - Gemini model to use
 * @param {Array} imageFiles - Optional array of image files
 */
export async function handleGeminiStreamingRequest(res, userContent, selectedModel, imageFiles = []) {
  try {
    console.log("Starting Gemini streaming request with", imageFiles?.length || 0, "images");
    // Generate the complete response first, passing any image files
    const botReply = await generateGeminiResponse(userContent, selectedModel, imageFiles);
    
    // Send the full reply as one SSE message
    res.write(`data: ${JSON.stringify({ chunk: botReply })}\n\n`);
    
    // End the SSE stream
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    
    // Return the full response for saving to database
    return botReply;
  } catch (error) {
    console.error("Gemini streaming error:", error);
    res.write(`data: ${JSON.stringify({ error: "Gemini API error: " + error.message })}\n\n`);
    res.end();
    throw error;
  }
}

/**
 * Test the Gemini API connection
 * 
 * @returns {Promise<Object>} Test result with success flag
 */
export async function testGeminiConnection() {
  if (!isGeminiConfigured()) {
    return { success: false, error: "Gemini API key not configured" };
  }
  
  try {
    const response = await generateGeminiResponse(
      "Hello, can you please reply with a simple test message?", 
      "gemini-pro"
    );
    return { success: true, response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}