import config from './config/env.js';

// Get API key from config
const GROK_API_KEY = config.grok.apiKey;

// Updated Grok model mapping
const GROK_MODEL_MAPPING = {
  'grok-1': 'grok-1',
  'grok-2': 'grok-2-latest',  // This is the multimodal version
  'grok-2-latest': 'grok-2-latest',
  'grok': 'grok-2-latest'  // Default to latest version
};

/**
 * Checks if a valid Grok API key is configured
 * @returns {boolean} True if API key is properly configured
 */
export function isGrokConfigured() {
  return config.grok.isConfigured();
}

/**
 * Get the correct Grok model name based on the input
 * 
 * @param {string} modelName - The model name provided by the user
 * @returns {string} - The correct Grok model identifier
 */
function getGrokModelName(modelName) {
  return GROK_MODEL_MAPPING[modelName] || 'grok-2-latest'; // Default to latest
}

/**
 * Generates a response from Grok API (non-streaming)
 * 
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The Grok model to use
 * @returns {Promise<string>} - Response text from Grok
 */
export async function generateGrokResponse(messages, model) {
  const grokModel = getGrokModelName(model);
  console.log(`🤖 Using Grok model: ${grokModel} (requested: ${model})`);
  
  if (!isGrokConfigured()) {
    console.error("🚨 Missing valid Grok API key");
    throw new Error("Grok API key not configured. Please contact administrator.");
  }
  
  try {
    // Create the request payload for Grok's OpenAI-compatible API
    const payload = {
      model: grokModel,
      messages: messages,
      max_tokens: 4000
    };
    
    console.log("Sending request to Grok API...");
    console.log("Grok payload:", JSON.stringify({
      model: grokModel,
      messagesCount: messages.length,
      hasImages: messages.some(msg => Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url'))
    }));
    
    // Call the Grok API using their OpenAI-compatible endpoint
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    // Check for errors
    if (!response.ok) {
      const errorData = await response.text();
      console.error("Grok API Error Response:", errorData);
      throw new Error(`Grok API error: ${response.status} ${response.statusText}`);
    }
    
    // Parse the response
    const data = await response.json();
    
    // Return the generated content
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Grok API Error:", error);
    throw error;
  }
}

/**
 * Generates a streaming response from Grok API
 * 
 * @param {object} res - Express response object for SSE
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The Grok model to use
 * @param {Function} onComplete - Callback function to execute when streaming is complete
 */
export async function generateGrokStreamingResponse(res, messages, model, onComplete) {
  const grokModel = getGrokModelName(model);
  console.log(`🤖 Streaming with Grok model: ${grokModel} (requested: ${model})`);
  
  if (!isGrokConfigured()) {
    console.error("🚨 Missing valid Grok API key");
    res.write(`data: ${JSON.stringify({ error: "Grok API key not configured. Please contact administrator." })}\n\n`);
    res.end();
    return;
  }
  
  try {
    // Check if there are any images in the messages
    const hasImages = messages.some(msg => 
      Array.isArray(msg.content) && 
      msg.content.some(part => part.type === 'image_url')
    );
    
    console.log(`Grok streaming request with ${hasImages ? 'images' : 'no images'}`);
    
    // Create the request payload
    const payload = {
      model: grokModel,
      messages: messages,
      max_tokens: 4000,
      stream: true
    };
    
    console.log("Grok streaming payload:", JSON.stringify({
      model: grokModel, 
      messagesCount: messages.length,
      hasImages: hasImages
    }));
    
    // Call the Grok API with streaming
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    // Check for errors
    if (!response.ok) {
      const errorData = await response.text();
      console.error("Grok API Error Response:", errorData);
      throw new Error(`Grok API error: ${response.status} ${response.statusText}`);
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
      
      // Grok API returns SSE data chunks just like OpenAI
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
            console.error('Error parsing Grok stream data:', e, line);
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
    console.error("❌ Grok Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: "Failed to generate AI response", details: error.message })}\n\n`);
    res.end();
    throw error;
  }
}

/**
 * Test the Grok API connection
 * 
 * @returns {Promise<Object>} Test result with success flag
 */
export async function testGrokConnection() {
  if (!isGrokConfigured()) {
    return { success: false, error: "Grok API key not configured" };
  }
  
  try {
    // Add more detailed logging for debugging
    console.log("Testing Grok connection with API key starting with:", 
                GROK_API_KEY ? GROK_API_KEY.substring(0, 4) + "..." : "undefined");
    
    const response = await generateGrokResponse([
      { role: "user", content: "Say hello!" }
    ], "grok-2-latest");
    
    return { success: true, response };
  } catch (error) {
    console.error("Grok test connection error:", error);
    return { success: false, error: error.message };
  }
}