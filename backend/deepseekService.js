import config from './config/env.js';

// Get API key from config
const DEEPSEEK_API_KEY = config.deepseek.apiKey;

// Corrected Deepseek model mapping
// Updated Deepseek model mapping
const DEEPSEEK_MODEL_MAPPING = {
  'deepseek-r1': 'deepseek-reasoner',      // Premium R1 model
  'deepseek': 'deepseek-chat',             // Free V3 model
  'deepseek-chat': 'deepseek-chat'         // Direct mapping for free V3 model
};

/**
 * Checks if a valid Deepseek API key is configured
 * @returns {boolean} True if API key is properly configured
 */
export function isDeepseekConfigured() {
  return config.deepseek.isConfigured();
}

/**
 * Get the correct Deepseek model name based on the input
 * 
 * @param {string} modelName - The model name provided by the user
 * @returns {string} - The correct Deepseek model identifier
 */
function getDeepseekModelName(modelName) {
  return DEEPSEEK_MODEL_MAPPING[modelName] || 'deepseek-chat'; // Default to deepseek-chat
}

/**
 * Generates a response from Deepseek API (non-streaming)
 * 
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The Deepseek model to use
 * @returns {Promise<string>} - Response text from Deepseek
 */
export async function generateDeepseekResponse(messages, model) {
  const deepseekModel = getDeepseekModelName(model);
  console.log(`🤖 Using Deepseek model: ${deepseekModel} (requested: ${model})`);
  
  if (!isDeepseekConfigured()) {
    console.error("🚨 Missing valid Deepseek API key");
    throw new Error("Deepseek API key not configured. Please contact administrator.");
  }
  
  try {
    // Create the request payload for Deepseek's OpenAI-compatible API
    const payload = {
      model: deepseekModel,
      messages: messages,
      max_tokens: 4000
    };
    
    console.log("Sending request to Deepseek API...");
    console.log("Deepseek payload:", JSON.stringify({
      model: deepseekModel,
      messagesCount: messages.length,
      hasImages: messages.some(msg => Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url'))
    }));
    
    // Call the Deepseek API using their OpenAI-compatible endpoint
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    // Check for errors with detailed logging
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Deepseek API Error Response:", errorText);
      console.error("Response status:", response.status);
      console.error("Response headers:", Object.fromEntries([...response.headers]));
      throw new Error(`Deepseek API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    // Parse the response
    const data = await response.json();
    
    // Return the generated content
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Deepseek API Error:", error);
    throw error;
  }
}

/**
 * Generates a streaming response from Deepseek API
 * 
 * @param {object} res - Express response object for SSE
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The Deepseek model to use
 * @param {Function} onComplete - Callback function to execute when streaming is complete
 */
export async function generateDeepseekStreamingResponse(res, messages, model, onComplete) {
  const deepseekModel = getDeepseekModelName(model);
  console.log(`🤖 Streaming with Deepseek model: ${deepseekModel} (requested: ${model})`);
  
  if (!isDeepseekConfigured()) {
    console.error("🚨 Missing valid Deepseek API key");
    res.write(`data: ${JSON.stringify({ error: "Deepseek API key not configured. Please contact administrator." })}\n\n`);
    res.end();
    return;
  }
  
  try {
    // Create the request payload
    const payload = {
      model: deepseekModel,
      messages: messages,
      max_tokens: 4000,
      stream: true
    };
    
    console.log("Deepseek streaming payload:", JSON.stringify({
      model: deepseekModel, 
      messagesCount: messages.length
    }));
    
    // Call the Deepseek API with streaming
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    // Check for errors
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Deepseek API Error Response:", errorText);
      console.error("Response status:", response.status);
      console.error("Response headers:", Object.fromEntries([...response.headers]));
      throw new Error(`Deepseek API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    // Process the streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let completeResponse = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      // Decode the chunk
      const chunk = decoder.decode(value, { stream: true });
      
      // Deepseek API returns SSE data chunks just like OpenAI
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            // Skip [DONE] message
            if (line === 'data: [DONE]') continue;
            
            // Parse the data
            const data = JSON.parse(line.substring(6));
            
            // Extract the content if present
            if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
              const content = data.choices[0].delta.content;
              res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
              completeResponse += content;
            }
          } catch (e) {
            console.error('Error parsing Deepseek stream data:', e, line);
          }
        }
      }
    }
    
    // Signal the end of stream
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    
    // Execute callback with the complete response
    if (typeof onComplete === 'function') {
      await onComplete(completeResponse);
    }
    
    return completeResponse;
  } catch (error) {
    console.error("❌ Deepseek Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: "Failed to generate AI response", details: error.message })}\n\n`);
    res.end();
    throw error;
  }
}

/**
 * Test the Deepseek API connection
 * 
 * @returns {Promise<Object>} Test result with success flag
 */
export async function testDeepseekConnection() {
  if (!isDeepseekConfigured()) {
    return { success: false, error: "Deepseek API key not configured" };
  }
  
  try {
    console.log("Testing Deepseek connection with API key starting with:", 
                DEEPSEEK_API_KEY ? DEEPSEEK_API_KEY.substring(0, 4) + "..." : "undefined");
    
    const response = await generateDeepseekResponse([
      { role: "user", content: "Say hello!" }
    ], "deepseek-chat");
    
    return { success: true, response };
  } catch (error) {
    console.error("Deepseek test connection error:", error);
    return { success: false, error: error.message };
  }
}