import config from './config/env.js';

// Get API key from config
const CLAUDE_API_KEY = config.claude.apiKey;

// Claude model mapping (old names → correct format)
const CLAUDE_MODEL_MAPPING = {
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20240620',
  'claude-3-7-sonnet': 'claude-3-7-sonnet-20250219', 
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-haiku': 'claude-3-5-haiku-20240307'
};

/**
 * Checks if a valid Claude API key is configured
 * @returns {boolean} True if API key is properly configured
 */
export function isClaudeConfigured() {
  return config.claude.isConfigured();
}

/**
 * Formats the conversation history for Claude API
 * 
 * @param {Array} messages - Messages in OpenAI-like format
 * @returns {Object} Messages formatted for Claude API
 */
function formatMessagesForClaude(messages) {
  // Extract system messages
  const systemMessages = messages.filter(msg => msg.role === "system");
  const systemPrompt = systemMessages.length > 0 ? systemMessages[0].content : "";
  
  // Convert OpenAI-style messages to Claude format
  const claudeMessages = [];
  
  for (const msg of messages) {
    if (msg.role === "system") continue; // Skip system messages
    
    if (msg.role === "user" || msg.role === "assistant") {
      // Handle messages with complex content (with images)
      if (Array.isArray(msg.content)) {
        const formattedContent = [];
        
        for (const contentPart of msg.content) {
          // Handle text content
          if (contentPart.type === "text") {
            formattedContent.push({
              type: "text",
              text: contentPart.text
            });
          }
          // Handle image content
          else if (contentPart.type === "image" || contentPart.type === "image_url") {
            // Image is already in Claude format
            if (contentPart.type === "image" && contentPart.source) {
              formattedContent.push(contentPart);
            } 
            // Convert from OpenAI format to Claude format
            else if (contentPart.type === "image_url" && contentPart.image_url) {
              // Handle base64 data URL
              if (contentPart.image_url.url.startsWith('data:')) {
                const parts = contentPart.image_url.url.split(',');
                const mediaType = parts[0].split(';')[0].split(':')[1];
                const base64Data = parts[1];
                
                formattedContent.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64Data
                  }
                });
              }
            }
          }
        }
        
        // Add the formatted message with complex content
        claudeMessages.push({
          role: msg.role,
          content: formattedContent
        });
      }
      // Handle simple text messages
      else if (typeof msg.content === 'string') {
        claudeMessages.push({
          role: msg.role,
          content: [{ type: "text", text: msg.content }]
        });
      }
    }
  }
  
  return {
    systemPrompt,
    messages: claudeMessages
  };
}

/**
 * Get the correct Claude model name based on the input
 * 
 * @param {string} modelName - The model name provided by the user
 * @returns {string} - The correct Claude model identifier
 */
function getClaudeModelName(modelName) {
  // If already in the correct format with version numbers, return as is
  if (modelName.includes('-202')) {
    return modelName;
  }
  
  // Otherwise map to the correct version
  return CLAUDE_MODEL_MAPPING[modelName] || 'claude-3-5-sonnet-20240620'; // Default to 3.5 Sonnet
}

/**
 * Generates a response from Claude API (non-streaming)
 * 
 * @param {Array} messages - Array of conversation messages (OpenAI format)
 * @param {string} model - The Claude model to use
 * @returns {Promise<string>} - Response text from Claude
 */
export async function generateClaudeResponse(messages, model) {
  const claudeModel = getClaudeModelName(model);
  console.log(`🤖 Using Claude model: ${claudeModel}`);
  
  if (!isClaudeConfigured()) {
    console.error("🚨 Missing valid Claude API key");
    throw new Error("Claude API key not configured. Please contact administrator.");
  }
  
  try {
    // Format the conversation for Claude API
    const { systemPrompt, messages: formattedMessages } = formatMessagesForClaude(messages);
    
    // Create the request payload for Claude API
    const claudePayload = {
      model: claudeModel,
      max_tokens: 4000,
      messages: formattedMessages
    };
    
    // Add system message if provided
    if (systemPrompt) {
      claudePayload.system = systemPrompt;
    }
    
    console.log("Sending request to Claude API...");
    console.log("Claude payload has", formattedMessages.length, "messages");
    
    // Check if we have any images
    let hasImages = false;
    for (const msg of formattedMessages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "image") {
            hasImages = true;
            console.log("Message contains images for Claude");
            break;
          }
        }
      }
      if (hasImages) break;
    }
    
    // Call the Claude API with updated headers
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(claudePayload)
    });
    
    // Check for errors
    if (!response.ok) {
      const errorData = await response.text();
      console.error("Claude API Error Response:", errorData);
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
    }
    
    // Parse the response
    const data = await response.json();
    
    // Return the generated content
    return data.content[0].text;
  } catch (error) {
    console.error("Claude API Error:", error);
    throw error;
  }
}

/**
 * Generates a streaming response from Claude API
 * 
 * @param {object} res - Express response object for SSE
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The Claude model to use
 * @param {Function} onComplete - Callback function to execute when streaming is complete
 */
export async function generateClaudeStreamingResponse(res, messages, model, onComplete) {
  const claudeModel = getClaudeModelName(model);
  console.log(`🤖 Streaming with Claude model: ${claudeModel}`);
  
  if (!isClaudeConfigured()) {
    console.error("🚨 Missing valid Claude API key");
    res.write(`data: ${JSON.stringify({ error: "Claude API key not configured. Please contact administrator." })}\n\n`);
    res.end();
    return;
  }
  
  try {
    // Format the conversation for Claude API
    const { systemPrompt, messages: formattedMessages } = formatMessagesForClaude(messages);
    
    // Create the request payload
    const claudePayload = {
      model: claudeModel,
      max_tokens: 4000,
      messages: formattedMessages,
      stream: true
    };
    
    // Add system message if provided
    if (systemPrompt) {
      claudePayload.system = systemPrompt;
    }
    
    // Check if we have any images
    let hasImages = false;
    for (const msg of formattedMessages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "image") {
            hasImages = true;
            console.log("Streaming request contains images for Claude");
            break;
          }
        }
      }
      if (hasImages) break;
    }
    
    // Call the Claude API with streaming
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(claudePayload)
    });
    
    // Check for errors
    if (!response.ok) {
      const errorData = await response.text();
      console.error("Claude API Error Response:", errorData);
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
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
      
      // Claude API returns SSE data chunks
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            // Skip [DONE] message
            if (line === 'data: [DONE]') continue;
            
            // Parse the data
            const data = JSON.parse(line.substring(6));
            
            // Extract the content if present (new format)
            if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
              const content = data.delta.text;
              res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
              completeResponse += content;
            }
          } catch (e) {
            console.error('Error parsing Claude stream data:', e, line);
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
    console.error("❌ Claude Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: "Failed to generate AI response", details: error.message })}\n\n`);
    res.end();
    throw error;
  }
}

/**
 * Test the Claude API connection
 * 
 * @returns {Promise<Object>} Test result with success flag
 */
export async function testClaudeConnection() {
  if (!isClaudeConfigured()) {
    return { success: false, error: "Claude API key not configured" };
  }
  
  try {
    // Use a simple test request
    const response = await generateClaudeResponse([
      { role: "user", content: "Say hello!" }
    ], "claude-3-5-sonnet");
    
    return { success: true, response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}