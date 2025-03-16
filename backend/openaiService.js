import OpenAI from "openai";
import config from './config/env.js';

// Get API key from config
const OPENAI_API_KEY = config.openai.apiKey;

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Checks if a valid OpenAI API key is configured
 * @returns {boolean} True if API key is properly configured
 */
export function isOpenAIConfigured() {
  return OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-');
}

/**
 * Generates a response from the OpenAI API (non-streaming)
 * 
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The OpenAI model to use
 * @returns {Promise<string>} - Response text from OpenAI
 */
export async function generateOpenAIResponse(messages, model) {
  console.log(`🤖 Using OpenAI model: ${model}`);
  
  if (!isOpenAIConfigured()) {
    console.error("🚨 Missing valid OpenAI API key");
    throw new Error("OpenAI API key not configured. Please contact administrator.");
  }
  
  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: messages,
      max_tokens: 3000
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
}

/**
 * Generates a streaming response from the OpenAI API
 * 
 * @param {object} res - Express response object for SSE
 * @param {Array} messages - Array of conversation messages
 * @param {string} model - The OpenAI model to use
 * @param {Function} onComplete - Callback function to execute when streaming is complete
 */
export async function generateOpenAIStreamingResponse(res, messages, model, onComplete) {
  console.log(`🤖 Streaming with OpenAI model: ${model}`);
  
  if (!isOpenAIConfigured()) {
    console.error("🚨 Missing valid OpenAI API key");
    res.write(`data: ${JSON.stringify({ error: "OpenAI API key not configured. Please contact administrator." })}\n\n`);
    res.end();
    return;
  }
  
  try {
    const stream = await openai.chat.completions.create({
      model: model,
      messages: messages,
      stream: true
    });
    
    let completeResponse = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
        completeResponse += content;
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
    console.error("❌ OpenAI Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: "Failed to generate AI response", details: error.message })}\n\n`);
    res.end();
    throw error;
  }
}

/**
 * Test the OpenAI API connection
 * 
 * @returns {Promise<Object>} Test result with success flag
 */
export async function testOpenAIConnection() {
  if (!isOpenAIConfigured()) {
    return { success: false, error: "OpenAI API key not configured" };
  }
  
  try {
    const response = await generateOpenAIResponse([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello!" }
    ], "gpt-3.5-turbo");
    
    return { success: true, response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}