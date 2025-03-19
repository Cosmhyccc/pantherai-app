// Add this function to the global scope for cross-browser debugging
window.debugUserChats = async function() {
    try {
      console.group("🧩 CROSS-BROWSER CHAT DIAGNOSTICS");
      
      // 1. Check authentication status
      const { data: sessionData } = await window.supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      const userEmail = sessionData?.session?.user?.email;
      
      console.log("Auth status:", sessionData?.session ? "Logged in" : "Not logged in");
      console.log("User ID:", userId || "Not available");
      console.log("User email:", userEmail || "Not available");
      
      if (!userId) {
        console.error("Not logged in - cannot fetch chats");
        console.groupEnd();
        return { error: "Not logged in" };
      }
      
      // 2. Check localStorage sessionId
      const currentSessionId = localStorage.getItem("sessionId");
      console.log("Current localStorage sessionId:", currentSessionId);
      
      // 3. Fetch all chats directly from database with explicit userId
      console.log("Fetching all chats for user ID:", userId);
      const { data: allChats, error: chatsError } = await window.supabase
        .from('chats')
        .select('id, messages, created_at, user_id')
        .eq('user_id', userId);
        
      if (chatsError) {
        console.error("Error fetching chats:", chatsError);
        console.groupEnd();
        return { error: chatsError.message };
      }
      
      console.log(`Found ${allChats?.length || 0} chats in database for user ${userId}`);
      
      // 4. Print detailed info about each chat
      if (allChats && allChats.length > 0) {
        allChats.forEach((chat, index) => {
          console.log(`Chat #${index+1}:`);
          console.log(`  ID: ${chat.id}`);
          console.log(`  User ID: ${chat.user_id}`);
          console.log(`  Created: ${new Date(chat.created_at).toLocaleString()}`);
          console.log(`  Message count: ${chat.messages?.length || 0}`);
          
          if (chat.messages && chat.messages.length > 0) {
            const firstUserMsg = chat.messages.find(m => m.role === "user");
            if (firstUserMsg) {
              console.log(`  First message: ${firstUserMsg.content.substring(0, 30)}${firstUserMsg.content.length > 30 ? '...' : ''}`);
            }
          }
        });
      }
      
      console.groupEnd();
      return {
        success: true,
        userId: userId,
        chatCount: allChats?.length || 0,
        chats: allChats.map(c => ({
          id: c.id,
          created: new Date(c.created_at).toLocaleString(),
          messageCount: c.messages?.length || 0
        }))
      };
    } catch (err) {
      console.error("Error in debugUserChats:", err);
      console.groupEnd();
      return { error: err.message };
    }
  };
  
  // Add this function to monitor and display all HTTP requests and responses
  (function() {
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
          const url = args[0];
          const options = args[1] || {};
          console.log(`📡 Fetch request: ${options.method || 'GET'} ${url}`, options);
          
          try {
              const response = await originalFetch(...args);
              const responseClone = response.clone();
              
              // Try to parse and log the response body when possible
              try {
                  const contentType = response.headers.get('content-type');
                  if (contentType && contentType.includes('application/json')) {
                      const jsonResponse = await responseClone.json();
                      console.log(`✅ Response from ${url}:`, jsonResponse);
                  } else {
                      console.log(`✅ Response from ${url}: [Non-JSON Response]`);
                  }
              } catch (e) {
                  console.log(`✅ Response from ${url}: [Unable to parse body]`);
              }
              
              return response;
          } catch (error) {
              console.error(`❌ Fetch error for ${url}:`, error);
              throw error;
          }
      };
  })();
  
  document.addEventListener("DOMContentLoaded", async function () {
      // Clear localStorage entries that might be causing cache issues
      localStorage.removeItem("chatHistory");
      // Keep the sessionId for the current browser tab
      const currentSessionId = localStorage.getItem("sessionId");
  
      // API URLs - using relative paths for same-origin requests
      const API_BASE_URL = "/api/chat";
      const API_STREAM_URL = "/api/chat/stream";
  
      // DOM element references
      const messagesContainer = document.getElementById("messages-container");
      const userInput = document.getElementById("userInput");
      const sendButton = document.getElementById("sendButton");
      const appContainer = document.getElementById("app");
      const prdEditorPanel = document.getElementById("prd-editor-panel");
      const prdContent = document.getElementById("prd-content");
      const closeEditorBtn = document.getElementById("closeEditorBtn");
      const copyEditorBtn = document.getElementById("copyEditorBtn");
      const openCanvasBtn = document.getElementById("openCanvasBtn");
      const uploadFileBtn = document.getElementById("uploadFileBtn");
      const fileInput = document.getElementById("fileInput");
      const streamControls = document.getElementById("streamControls");
      const cancelStreamBtn = document.getElementById("cancelStreamBtn");
      const inputContainer = document.getElementById("input-container");
      // New elements for auth & subscription
      const loginArea = document.getElementById("login-area");
      const loginButton = document.getElementById("loginButton");
      const userInfo = document.getElementById("user-info");
      const userEmail = document.getElementById("user-email");
      const logoutButton = document.getElementById("logoutButton");
      const subscribeButton = document.getElementById("subscribeButton");
      const deleteChatButton = document.getElementById("deleteChatButton");
      // Elements for chat history
      const chatsContainer = document.getElementById("chats-container");
      const chatTitle = document.getElementById("chat-title");
      const newChatBtn = document.getElementById("new-chat-btn");
  
      // Auto-focus the input field when the page loads
      if (userInput) userInput.focus();
      // Auto-resize textarea on input
      function autoResizeTextarea() {
          userInput.style.height = 'auto';
          userInput.style.height = userInput.scrollHeight + 'px';
      }
      if (userInput) {
          userInput.addEventListener("input", autoResizeTextarea);
          // Reset height when input is empty
          userInput.addEventListener("focus", function() {
              if (userInput.value.trim() === '') {
                  userInput.style.height = '36px';
              }
          });
      }
  
      // File uploads related
      let uploadedFiles = [];
      // Streaming control flags
      let activeStream = false;
      let streamController = null;
      // Track PRD content (not directly related to auth)
      let currentPrd = "";
      let editorOpen = false;
      let prdDetected = false;
      // Auth token and premium model list
      let authToken = null;
      const premiumModels = ["gpt-4", "claude", "grok", "deepseek"];
      let retryCount = 0;
      const MAX_RETRIES = 3;
  
      // Store session data in memory
      const sessionFiles = new Map();
      const userConversations = new Map();
      const userSelectedModel = new Map();
  
      // Preserve sessionId across reloads (clear other local data)
      window.addEventListener('beforeunload', function() {
          localStorage.removeItem("currentPrd");
          // Note: do NOT remove sessionId so conversation persists
      });
  
      // Ensure required elements exist
      if (!messagesContainer || !userInput || !sendButton || !inputContainer) {
          console.error("Error: One or more elements not found!");
          return;
      }
  
      // Debug function to examine database contents
      window.debugDatabaseContents = async function() {
          try {
              console.log("Debugging database contents...");
              
              // Get current session ID
              const currentSessionId = localStorage.getItem("sessionId");
              console.log("Current session ID:", currentSessionId);
              
              // Make sure we have a valid auth token
              const { data: sessionData } = await window.supabase.auth.getSession();
              if (!sessionData || !sessionData.session) {
                  console.error("No valid auth session");
                  return;
              }
              
              // Check if current chat exists in database
              const { data: chatData, error: chatError } = await window.supabase
                  .from('chats')
                  .select('*')
                  .eq('id', currentSessionId);
                  
              if (chatError) {
                  console.error("Error fetching chat:", chatError);
              }
              
              console.log("Chat data from database:", chatData);
              
              // Get all user chats
              const { data: allChats, error: allChatsError } = await window.supabase
                  .from('chats')
                  .select('id, messages, created_at, message_count');
                  
              if (allChatsError) {
                  console.error("Error fetching all chats:", allChatsError);
              } else {
                  console.log("All chats in database:", allChats);
              }
              
              // Compare with localStorage chat history
              const localHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
              console.log("Local storage chat history:", localHistory);
              
              return {
                  currentChat: chatData,
                  allChats: allChats,
                  localHistory: localHistory
              };
          } catch (err) {
              console.error("Debug error:", err);
              return null;
          }
      };
  
      // New function to load all chats for the current user
      async function loadUserChats() {
          console.log("Loading user chats from database...");
          
          try {
              // Refresh token to ensure it's valid
              const { data: sessionData } = await window.supabase.auth.getSession();
              if (!sessionData || !sessionData.session) {
                  console.error("No valid session available");
                  return [];
              }
              
              const userId = sessionData.session.user.id;
              authToken = sessionData.session.access_token;
              
              if (!authToken) {
                  console.error("No valid auth token available");
                  return [];
              }
              
              console.log("Fetching all chats for user ID:", userId);
              
              // Fetch all chats for the current user with explicit user_id filter
              // FIXED: Always fetch chats regardless of subscription status
              const { data: chats, error } = await window.supabase
                  .from('chats')
                  .select('id, messages, created_at')
                  .eq('user_id', userId)
                  .order('created_at', { ascending: false });
                  
              if (error) {
                  console.error("Error fetching user chats:", error);
                  return [];
              }
              
              console.log(`Found ${chats?.length || 0} chats for user ${userId}`);
              
              // Extract title and timestamp for each chat
              const processedChats = chats.map(chat => {
                  // Extract title from first user message
                  let title = "New Chat";
                  if (chat.messages && Array.isArray(chat.messages) && chat.messages.length > 0) {
                      const firstUserMsg = chat.messages.find(m => m.role === "user");
                      if (firstUserMsg) {
                          title = firstUserMsg.content.length > 30 ? 
                              firstUserMsg.content.substring(0, 30) + "..." : 
                              firstUserMsg.content;
                      }
                  }
                  
                  return {
                      id: chat.id,
                      title: title,
                      timestamp: chat.created_at
                  };
              });
              
              console.log("Processed chats for UI:", processedChats);
              return processedChats;
          } catch (err) {
              console.error("Exception loading user chats:", err);
              return [];
          }
      }
  
      // Enhanced loadChatHistory function with better debugging
      async function loadChatHistory(sessionId) {
          console.log("Loading chat history for session:", sessionId);
          
          // Only proceed if we have a valid sessionId
          if (!sessionId) {
              console.error("Cannot load chat, missing sessionId");
              return false;
          }
          
          try {
              // Refresh token to ensure it's valid
              const { data: sessionData } = await window.supabase.auth.getSession();
              
              // FIXED: If not logged in, return early
              if (!sessionData || !sessionData.session) {
                  console.error("Cannot load chat, not logged in");
                  return false;
              }
              
              authToken = sessionData.session.access_token;
              
              // Check if we have the in-memory conversation for this session
              if (!userConversations.has(sessionId)) {
                  userConversations.set(sessionId, [{ role: "system", content: "You are PantherAI, a helpful assistant." }]);
              }
              
              // Fetch chat history from Supabase with detailed logging
              console.log(`Fetching chat with ID ${sessionId} from Supabase...`);
              
              const { data: chat, error } = await window.supabase
                  .from('chats')
                  .select('messages, id, created_at, message_count')
                  .eq('id', sessionId)
                  .single();
                  
              if (error) {
                  console.error("Error fetching chat history:", error);
                  return false;
              }
              
              console.log("Raw chat data from database:", chat);
              
              if (!chat || !chat.messages) {
                  console.warn(`No messages found for chat session: ${sessionId}`);
                  return false;
              }
              
              if (!Array.isArray(chat.messages)) {
                  console.error("Chat messages is not an array:", typeof chat.messages);
                  return false;
              }
              
              console.log(`Found ${chat.messages.length} messages for session ${sessionId}`);
              
              // Clear the current messages
              messagesContainer.innerHTML = "";
              
              // Initialize or update the in-memory conversation history
              const systemPrompt = { role: "system", content: "You are PantherAI, a helpful assistant." };
              userConversations.set(sessionId, [systemPrompt]);
              
              // Display messages in the UI and update conversation history
              let messagesAdded = 0;
              chat.messages.forEach(message => {
                  if (typeof message !== 'object' || !message.role || !message.content) {
                      console.warn("Invalid message format:", message);
                      return; // Skip invalid messages
                  }
                  
                  // Map "assistant" role to "bot" for UI display
                  const displayRole = message.role === "assistant" ? "bot" : message.role;
                  
                  // Add to UI with the correct role mapping
                  appendMessage(message.content, displayRole);
                  messagesAdded++;
                  
                  // Add to in-memory conversation history
                  userConversations.get(sessionId).push(message);
              });
              
              console.log(`Added ${messagesAdded} messages to UI`);
              
              // Update chat title
              if (chat.messages.length > 0) {
                  const firstUserMsg = chat.messages.find(m => m.role === "user");
                  if (firstUserMsg) {
                      const newTitle = firstUserMsg.content.length > 30 ? 
                          firstUserMsg.content.substring(0, 30) + "..." : 
                          firstUserMsg.content;
                      chatTitle.textContent = newTitle;
                      console.log("Updated chat title to:", newTitle);
                  }
              }
              
              // Scroll to bottom
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
              return true;
          } catch (err) {
              console.error("Exception loading chat history:", err);
              return false;
          }
      }
  
      // Add this function to your chat.js file
  window.debugChatLoading = async function() {
      const sessionId = localStorage.getItem("sessionId");
      console.log("Debug: Current sessionId:", sessionId);
      
      try {
        // 1. Get current user auth
        const { data: sessionData } = await window.supabase.auth.getSession();
        console.log("Debug: Auth valid:", !!sessionData?.session?.access_token);
        
        // 2. Try to fetch directly from database
        const { data: chatData, error: chatError } = await window.supabase
          .from('chats')
          .select('*')
          .eq('id', sessionId)
          .maybeSingle();
          
        if (chatError) {
          console.error("Debug: Error fetching chat:", chatError);
        }
        
        console.log("Debug: Chat found in database:", !!chatData);
        console.log("Debug: Chat data:", chatData);
        
        // 3. List all chats in database
        const { data: allChats } = await window.supabase
          .from('chats')
          .select('id, messages, created_at')
          .eq('user_id', sessionData?.session?.user?.id);
          
        console.log("Debug: All user chats:", allChats || []);
        
        // 4. If chat exists, try displaying it in UI
        if (chatData && Array.isArray(chatData.messages) && chatData.messages.length > 0) {
          console.log("Debug: Attempting to display", chatData.messages.length, "messages");
          
          // Clear current messages
          document.getElementById("messages-container").innerHTML = "";
          
          // Display messages
          chatData.messages.forEach((msg, i) => {
            console.log(`Debug: Displaying message ${i+1}:`, msg.role, msg.content.substring(0, 30) + "...");
            
            const messageDiv = document.createElement("div");
            messageDiv.classList.add("message", msg.role);
            
            // Add content
            if (msg.role === "bot") {
              messageDiv.innerHTML = "<div class='message-content'>" + marked.parse(DOMPurify.sanitize(msg.content)) + "</div>";
            } else {
              messageDiv.innerHTML = "<div class='message-content'>" + DOMPurify.sanitize(msg.content) + "</div>";
            }
            
            document.getElementById("messages-container").appendChild(messageDiv);
          });
          
          console.log("Debug: Messages should now be displayed");
          return true;
        } else {
          console.log("Debug: No messages found or chat data invalid");
          return false;
        }
      } catch (err) {
        console.error("Debug: Exception in debugChatLoading:", err);
        return false;
      }
    };
  
      // Add debug button for subscription issues and chat refresh button
function addDebugButton() {
    if (userInfo) {
        // Check if debug button already exists
        if (document.getElementById('debug-subscription-btn')) return;
        
        // Add subscription debug button
        const debugBtn = document.createElement('button');
        debugBtn.id = 'debug-subscription-btn';
        debugBtn.textContent = '🔍';
        debugBtn.title = 'Debug Subscription';
        debugBtn.style.marginLeft = '8px';
        debugBtn.style.padding = '4px 8px';
        debugBtn.style.fontSize = '10px';
        debugBtn.style.backgroundColor = '#333';
        debugBtn.onclick = async () => {
            await openDebugPanel();
        };
        userInfo.appendChild(debugBtn);
        
        // Add refresh chats button
        if (!document.getElementById('refresh-chats-btn')) {
            const refreshButton = document.createElement('button');
            refreshButton.id = 'refresh-chats-btn';
            refreshButton.textContent = '🔄 Refresh Chats';
            refreshButton.title = 'Refresh chat history across browsers';
            refreshButton.style.marginLeft = '10px';
            refreshButton.style.padding = '5px 10px';
            refreshButton.style.backgroundColor = '#4CAF50';
            refreshButton.style.color = 'white';
            refreshButton.style.border = 'none';
            refreshButton.style.borderRadius = '4px';
            refreshButton.style.cursor = 'pointer';
            refreshButton.onclick = async () => {
                refreshButton.disabled = true;
                refreshButton.textContent = 'Refreshing...';
                
                try {
                    // Force clear local storage and fetch all chats from database
                    localStorage.removeItem("chatHistory");
                    
                    // Run the debug function to help diagnose
                    if (window.debugUserChats) {
                        await window.debugUserChats();
                    }
                    
                    // Force fresh fetch from database
                    await renderChatHistory();
                    
                    refreshButton.textContent = '✅ Refreshed!';
                    setTimeout(() => {
                        refreshButton.textContent = '🔄 Refresh Chats';
                        refreshButton.disabled = false;
                    }, 2000);
                } catch (e) {
                    console.error("Error refreshing chats:", e);
                    refreshButton.textContent = '❌ Error';
                    setTimeout(() => {
                        refreshButton.textContent = '🔄 Refresh Chats';
                        refreshButton.disabled = false;
                    }, 2000);
                }
            };
            userInfo.appendChild(refreshButton);
        }
    }
}
  
      // Open debug panel with subscription details and fix options
      async function openDebugPanel() {
          // Create debug panel
          const debugPanel = document.createElement('div');
          debugPanel.style.position = 'fixed';
          debugPanel.style.top = '60px';
          debugPanel.style.right = '20px';
          debugPanel.style.width = '400px';
          debugPanel.style.padding = '20px';
          debugPanel.style.backgroundColor = '#222';
          debugPanel.style.color = 'white';
          debugPanel.style.zIndex = '1000';
          debugPanel.style.borderRadius = '8px';
          debugPanel.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
          debugPanel.style.overflowY = 'auto';
          debugPanel.style.maxHeight = '80vh';
          
          // Add close button
          const closeBtn = document.createElement('button');
          closeBtn.textContent = '✕';
          closeBtn.style.position = 'absolute';
          closeBtn.style.top = '10px';
          closeBtn.style.right = '10px';
          closeBtn.onclick = () => debugPanel.remove();
          debugPanel.appendChild(closeBtn);
          
          // Add title
          const title = document.createElement('h3');
          title.textContent = 'Subscription Debug';
          debugPanel.appendChild(title);
          
          // Add user info
          const { data: sessionData } = await window.supabase.auth.getSession();
          const userInfoDiv = document.createElement('div');
          if (sessionData?.session?.user) {
              userInfoDiv.innerHTML = `<p>User: ${sessionData.session.user.email}</p>`;
              debugPanel.appendChild(userInfoDiv);
              
              // Check subscription direct API
              try {
                  const response = await fetch('/api/subscription-check', {
                      headers: {
                          'Authorization': `Bearer ${authToken}`
                      }
                  });
                  
                  const result = await response.json();
                  const apiStatus = document.createElement('div');
                  apiStatus.innerHTML = `
                      <h4>API Status:</h4>
                      <pre>${JSON.stringify(result, null, 2)}</pre>
                  `;
                  debugPanel.appendChild(apiStatus);
              } catch (e) {
                  console.error("API check failed:", e);
              }
              
              // Add fix buttons
              const fixButtons = document.createElement('div');
              fixButtons.style.marginTop = '15px';
              
              const forceBtn = document.createElement('button');
              forceBtn.textContent = 'Force Update';
              forceBtn.style.marginRight = '10px';
              forceBtn.onclick = async () => {
                  forceBtn.disabled = true;
                  forceBtn.textContent = 'Working...';
                  try {
                      const response = await fetch('/api/force-subscription-update', {
                          headers: {
                              'Authorization': `Bearer ${authToken}`
                          }
                      });
                      const result = await response.json();
                      alert(result.success ? 'Subscription forced! Refreshing page...' : 'Failed: ' + result.error);
                      if (result.success) location.reload();
                  } catch (e) {
                      alert('Error: ' + e.message);
                  }
                  forceBtn.disabled = false;
                  forceBtn.textContent = 'Force Update';
              };
              
              const dbFixBtn = document.createElement('button');
              dbFixBtn.textContent = 'Fix Database';
              dbFixBtn.style.marginRight = '10px';
              dbFixBtn.onclick = async () => {
                  dbFixBtn.disabled = true;
                  dbFixBtn.textContent = 'Working...';
                  try {
                      const response = await fetch('/api/fix-db', {
                          headers: {
                              'Authorization': `Bearer ${authToken}`
                          }
                      });
                      const result = await response.json();
                      alert(result.success ? 'Database fixed! Refreshing page...' : 'Failed: ' + result.error);
                      if (result.success) location.reload();
                  } catch (e) {
                      alert('Error: ' + e.message);
                  }
                  dbFixBtn.disabled = false;
                  dbFixBtn.textContent = 'Fix Database';
              };
              
              const adminBtn = document.createElement('button');
              adminBtn.textContent = 'Admin Override';
              adminBtn.onclick = async () => {
                  adminBtn.disabled = true;
                  adminBtn.textContent = 'Working...';
                  try {
                      const response = await fetch('/api/admin/override-subscription', {
                          method: 'POST',
                          headers: {
                              'Content-Type': 'application/json',
                              'Authorization': `Bearer ${authToken}`
                          },
                          body: JSON.stringify({
                              userId: sessionData.session.user.id,
                              action: 'enable'
                          })
                      });
                      const result = await response.json();
                      alert(result.success ? 'Admin override successful! Refreshing page...' : 'Failed: ' + result.error);
                      if (result.success) location.reload();
                  } catch (e) {
                      alert('Error: ' + e.message);
                  }
                  adminBtn.disabled = false;
                  adminBtn.textContent = 'Admin Override';
              };
              
              fixButtons.appendChild(forceBtn);
              fixButtons.appendChild(dbFixBtn);
              fixButtons.appendChild(adminBtn);
              debugPanel.appendChild(fixButtons);
          } else {
              userInfoDiv.innerHTML = `<p>Not logged in</p>`;
              debugPanel.appendChild(userInfoDiv);
          }
          
          // Add to body
          document.body.appendChild(debugPanel);
      }
  
      // Add a force refresh chats button (for debugging)
      function addDebugRefreshButton() {
          // Check if button already exists
          if (document.getElementById('refresh-chats-btn')) return;
          
          const refreshBtn = document.createElement('button');
          refreshBtn.id = 'refresh-chats-btn';
          refreshBtn.textContent = '🔄 Refresh Chats';
          refreshBtn.style.position = 'fixed';
          refreshBtn.style.bottom = '20px';
          refreshBtn.style.right = '20px';
          refreshBtn.style.zIndex = '1000';
          refreshBtn.style.padding = '8px 12px';
          refreshBtn.style.backgroundColor = 'var(--accent-primary)';
          refreshBtn.style.color = 'white';
          refreshBtn.style.border = 'none';
          refreshBtn.style.borderRadius = '4px';
          refreshBtn.style.cursor = 'pointer';
          
          refreshBtn.onclick = async () => {
              refreshBtn.disabled = true;
              refreshBtn.textContent = 'Refreshing...';
              
              console.log("Manually refreshing chat history...");
              
              // Clear the chat list first
              chatsContainer.innerHTML = "";
              
              try {
                  // Force reload chats from database
                  const { data: sessionData } = await window.supabase.auth.getSession();
                  if (!sessionData?.session?.user?.id) {
                      alert("You need to be logged in to refresh chats");
                      refreshBtn.disabled = false;
                      refreshBtn.textContent = '🔄 Refresh Chats';
                      return;
                  }
                  
                  const userId = sessionData.session.user.id;
                  
                  // Directly query database with cache-busting query
                  const { data: chats, error } = await window.supabase
                      .from('chats')
                      .select('id, messages, created_at')
                      .eq('user_id', userId)
                      .order('created_at', { ascending: false });
                  
                  if (error) {
                      console.error("Failed to refresh chats:", error);
                      alert("Error refreshing chats: " + error.message);
                      refreshBtn.disabled = false;
                      refreshBtn.textContent = '🔄 Refresh Failed';
                      return;
                  }
                  
                  console.log(`Refreshed ${chats.length} chats for user ${userId}`);
                  
                  // Display in console for debugging
                  window.debugUserChats();
                  
                  // Manually render chat history
                  await renderChatHistory();
                  
                  refreshBtn.disabled = false;
                  refreshBtn.textContent = '✅ Refreshed!';
                  setTimeout(() => {
                      refreshBtn.textContent = '🔄 Refresh Chats';
                  }, 2000);
              } catch (e) {
                  console.error("Refresh error:", e);
                  refreshBtn.disabled = false;
                  refreshBtn.textContent = '🔄 Error';
                  setTimeout(() => {
                      refreshBtn.textContent = '🔄 Refresh Chats';
                  }, 2000);
              }
          };
          
          document.body.appendChild(refreshBtn);
      }
  
      // Model selection via dropdown
      const modelSelect = document.getElementById("model-select");
      let selectedModel = localStorage.getItem("selectedModel") || "gpt-3.5-turbo";
      if (modelSelect) {
          modelSelect.value = selectedModel;
          modelSelect.addEventListener("change", () => {
              selectedModel = modelSelect.value;
              localStorage.setItem("selectedModel", selectedModel);
              // Do not clear history on model switch
          });
      }
  
      // Update UI based on subscription status
      function updateUIForSubscription(isSubscribed) {
          console.log("Updating UI for subscription status:", isSubscribed);
          // Update subscription button visibility
          subscribeButton.style.display = isSubscribed ? "none" : "inline-block";
          
          // Update model dropdown options
          if (modelSelect) {
              for (let opt of modelSelect.options) {
                  if (premiumModels.some(pm => opt.value.toLowerCase().includes(pm))) {
                      opt.disabled = !isSubscribed;
                      if (!isSubscribed && !opt.textContent.includes(" (Premium)")) {
                          opt.textContent += " (Premium)";
                      } else if (isSubscribed) {
                          opt.textContent = opt.textContent.replace(" (Premium)", "");
                      }
                  }
              }
          }
          
          // Add subscription badge if subscribed
          const existingBadge = document.getElementById("premium-badge");
          if (isSubscribed && !existingBadge) {
              const badge = document.createElement("span");
              badge.id = "premium-badge";
              badge.style.background = "var(--accent-primary)";
              badge.style.color = "white";
              badge.style.padding = "2px 8px";
              badge.style.borderRadius = "4px";
              badge.style.fontSize = "12px";
              badge.style.marginLeft = "8px";
              badge.textContent = "PREMIUM";
              userEmail.parentNode.insertBefore(badge, userEmail.nextSibling);
          } else if (!isSubscribed && existingBadge) {
              existingBadge.remove();
          }
      }
  
      // Function to manually refresh subscription status using server API
      async function refreshSubscriptionStatus() {
          console.log("Refreshing subscription status from server...");
          
          try {
              // Force refresh token to ensure latest session data
              const { data: sessionData } = await window.supabase.auth.getSession();
              if (!sessionData || !sessionData.session) {
                  console.log("No valid session for subscription check");
                  return false;
              }
              
              authToken = sessionData.session.access_token;
              
              // Use the server API directly instead of Supabase client
              const response = await fetch('/api/subscription-check', {
                  headers: {
                      'Authorization': `Bearer ${authToken}`
                  }
              });
              
              if (response.ok) {
                  const result = await response.json();
                  console.log("Server subscription check result:", result);
                  
                  // Trust the server's computed isSubscribed value
                  userIsSubscribed = result.isSubscribed;
                  updateUIForSubscription(userIsSubscribed);
                  
                  return userIsSubscribed;
              } else {
                  console.error("Server subscription check failed:", await response.text());
                  return false;
              }
          } catch (err) {
              console.error("Error refreshing subscription status:", err);
              return false;
          }
      }
  
      // Function to force update subscription through direct API call
      async function forceSubscriptionUpdate() {
          try {
              console.log("Forcing subscription update...");
              const response = await fetch('/api/force-subscription-update', {
                  headers: {
                      'Authorization': `Bearer ${authToken}`
                  }
              });
              
              const result = await response.json();
              console.log("Force update result:", result);
              
              if (result.success) {
                  userIsSubscribed = true;
                  updateUIForSubscription(true);
                  return true;
              }
              return false;
          } catch (e) {
              console.error("Error forcing subscription update:", e);
              return false;
          }
      }
  
      // Function to fix the database (create user record or enable subscription)
      async function fixDatabaseRecord() {
          try {
              console.log("Attempting to fix user database record...");
              const response = await fetch('/api/fix-db', {
                  headers: {
                      'Authorization': `Bearer ${authToken}`
                  }
              });
              
              const result = await response.json();
              console.log("Database fix result:", result);
              
              if (result.success) {
                  userIsSubscribed = true;
                  updateUIForSubscription(true);
                  return true;
              }
              return false;
          } catch (e) {
              console.error("Error fixing database:", e);
              return false;
          }
      }
  
      // Try multiple approaches to activate subscription
      async function activateSubscription() {
          console.log("Starting subscription activation process...");
          
          // 1. Try to force update directly through API
          try {
              console.log("Attempting direct force update...");
              const forceResponse = await fetch('/api/force-subscription-update', {
                  headers: {
                      'Authorization': `Bearer ${authToken}`
                  }
              });
              
              if (forceResponse.ok) {
                  const result = await forceResponse.json();
                  if (result.success) {
                      console.log("Force update successful:", result);
                      userIsSubscribed = true;
                      updateUIForSubscription(true);
                      return true;
                  }
              }
          } catch (e) {
              console.error("Force update failed:", e);
          }
          
          // 2. Try database fix
          try {
              console.log("Attempting database fix...");
              const dbFixResponse = await fetch('/api/fix-db', {
                  headers: {
                      'Authorization': `Bearer ${authToken}`
                  }
              });
              
              if (dbFixResponse.ok) {
                  const result = await dbFixResponse.json();
                  if (result.success) {
                      console.log("Database fix successful:", result);
                      userIsSubscribed = true;
                      updateUIForSubscription(true);
                      return true;
                  }
              }
          } catch (e) {
              console.error("Database fix failed:", e);
          }
          
          // 3. Try admin override
          try {
              console.log("Attempting admin override...");
              const { data: userData } = await window.supabase.auth.getUser();
              if (userData?.user?.id) {
                  const overrideResponse = await fetch('/api/admin/override-subscription', {
                      method: 'POST',
                      headers: {
                          'Content-Type': 'application/json',
                          'Authorization': `Bearer ${authToken}`
                      },
                      body: JSON.stringify({
                          userId: userData.user.id,
                          action: 'enable'
                      })
                  });
                  
                  if (overrideResponse.ok) {
                      const result = await overrideResponse.json();
                      if (result.success) {
                          console.log("Admin override successful:", result);
                          userIsSubscribed = true;
                          updateUIForSubscription(true);
                          return true;
                      }
                  }
              }
          } catch (e) {
              console.error("Admin override failed:", e);
          }
          
          return false;
      }
  
      // Handle initial authentication state
      const { data: { session } } = await window.supabase.auth.getSession();
      let userIsSubscribed = false;
      if (session && session.user) {
          authToken = session.access_token;
          console.log("✅ User authenticated:", session.user.email);
          // Log for debugging
          console.log("Full auth header being sent:", `Bearer ${authToken.substring(0, 10)}...`);
          console.log("Token length:", authToken ? authToken.length : "No token");
          
          // Fetch subscription status with better error handling
          try {
              // Try the API endpoint first (more reliable)
              try {
                  const response = await fetch('/api/subscription-check', {
                      headers: {
                          'Authorization': `Bearer ${authToken}`
                      }
                  });
                  
                  if (response.ok) {
                      const result = await response.json();
                      console.log("Initial API subscription check:", result);
                      userIsSubscribed = result.isSubscribed || false;
                  }
              } catch (err) {
                  console.error("API subscription check failed:", err);
                  
                  // Fall back to database query
                  const { data: profile } = await window.supabase.from('users').select('is_subscribed').eq('id', session.user.id).maybeSingle();
                  userIsSubscribed = profile?.is_subscribed || false;
              }
          } catch (err) {
              console.error("Error fetching initial subscription status:", err);
          }
          
          // Show chat UI for logged-in user
          loginArea.style.display = "none";
          appContainer.style.display = "block";
          userInfo.style.display = "flex";
          userEmail.textContent = session.user.email;
          logoutButton.style.display = "inline-block";
          subscribeButton.style.display = userIsSubscribed ? "none" : "inline-block";
          // Update UI based on subscription status
          updateUIForSubscription(userIsSubscribed);
          
          // Add debug button for admins/developers
          addDebugButton();
          
          // Add the refresh chats button
          addDebugRefreshButton();
      } else {
          // Not logged in: show login UI
          appContainer.style.display = "none";
          loginArea.style.display = "flex";
      }
  
      // Check URL for Stripe checkout result
      const params = new URLSearchParams(window.location.search);
      if (params.get('checkout') === 'success') {
          console.log("💰 Checkout success detected! Session ID:", params.get('session_id'));
          
          // Show a loading indicator
          const loadingDiv = document.createElement("div");
          loadingDiv.id = "subscription-loading";
          loadingDiv.style.position = "fixed";
          loadingDiv.style.top = "60px";
          loadingDiv.style.left = "50%";
          loadingDiv.style.transform = "translateX(-50%)";
          loadingDiv.style.padding = "8px 16px";
          loadingDiv.style.background = "var(--accent-primary)";
          loadingDiv.style.color = "white";
          loadingDiv.style.borderRadius = "4px";
          loadingDiv.style.zIndex = "1000";
          loadingDiv.innerHTML = "Activating premium features...";
          document.body.appendChild(loadingDiv);
          
          // Try multiple approaches for maximum reliability
          let retries = 0;
          const maxRetries = 5;
          
          async function checkWithRetry() {
              console.log(`Checking subscription status (attempt ${retries + 1}/${maxRetries})...`);
              
              // Try to refresh the subscription status
              const isSubscribed = await refreshSubscriptionStatus();
              
              if (isSubscribed) {
                  // Success! Update UI and show message
                  if (document.getElementById("subscription-loading")) {
                      document.getElementById("subscription-loading").remove();
                  }
                  
                  // Force select a premium model to demonstrate it works
                  if (modelSelect) {
                      for (let opt of modelSelect.options) {
                          if (premiumModels.some(pm => opt.value.toLowerCase().includes(pm))) {
                              modelSelect.value = opt.value;
                              selectedModel = opt.value;
                              localStorage.setItem("selectedModel", selectedModel);
                              break;
                          }
                      }
                  }
                  
                  alert("🎉 Subscription successful! Premium features are now enabled.");
                  return true;
              }
              
              // Not subscribed yet, try again or use force methods
              retries++;
              if (retries < maxRetries) {
                  // Wait 1.5 seconds before retry
                  await new Promise(resolve => setTimeout(resolve, A));
                  return await checkWithRetry();
              }
              
              // Max retries reached, try to force activate
              console.log("Max retries reached, attempting force activation...");
              const activated = await activateSubscription();
              
              if (document.getElementById("subscription-loading")) {
                  document.getElementById("subscription-loading").remove();
              }
              
              if (activated) {
                  // Force select a premium model
                  if (modelSelect) {
                      for (let opt of modelSelect.options) {
                          if (premiumModels.some(pm => opt.value.toLowerCase().includes(pm))) {
                              modelSelect.value = opt.value;
                              selectedModel = opt.value;
                              localStorage.setItem("selectedModel", selectedModel);
                              break;
                          }
                      }
                  }
                  
                  alert("🎉 Subscription successful! Premium features are now enabled.");
              } else {
                  alert("Subscription processed, but may take a moment to activate. Please refresh the page if premium features aren't available.");
              }
              
              return activated;
          }
          
          // Start the subscription check process
          checkWithRetry();
          
          // Remove query params to prevent duplicate alerts
          window.history.replaceState({}, document.title, window.location.pathname);
      } else if (params.get('checkout') === 'cancel') {
          setTimeout(() => {
              alert("Subscription was canceled or not completed.");
          }, 1000);
          window.history.replaceState({}, document.title, window.location.pathname);
      }
  
      // Google OAuth login button
      loginButton.addEventListener("click", async () => {
          try {
              const { error } = await window.supabase.auth.signInWithOAuth({
                  provider: 'google',
                  options: {
                      redirectTo: window.location.origin
                  }
              });
              if (error) {
                  console.error("Google login error:", error);
                  alert("Login failed. Please try again.");
              }
          } catch (e) {
              console.error("Login exception:", e);
              alert("An error occurred during login. Please try again.");
          }
      });
      
      // Logout button
      logoutButton.addEventListener("click", async () => {
          await window.supabase.auth.signOut();
          authToken = null;
          appContainer.style.display = "none";
          loginArea.style.display = "flex";
          userInfo.style.display = "none";
      });
      
      // Subscribe (Upgrade) button
      subscribeButton.addEventListener("click", async () => {
          try {
              // Show loading state
              subscribeButton.disabled = true;
              subscribeButton.textContent = "Processing...";
              
              // Refresh token before making the request
              const { data: sessionData } = await window.supabase.auth.getSession();
              authToken = sessionData.session?.access_token;
              
              if (!authToken) {
                  alert("Authentication error. Please refresh the page and try again.");
                  subscribeButton.disabled = false;
                  subscribeButton.textContent = "Upgrade";
                  return;
              }
              
              // Use the correct API endpoint
              const res = await fetch(`/api/create-checkout-session`, {
                  method: "POST",
                  headers: {
                      "Content-Type": "application/json",
                      "Authorization": `Bearer ${authToken}`
                  }
              });
              
              if (!res.ok) {
                  const errorData = await res.json();
                  throw new Error(errorData.error || "Failed to create checkout session");
              }
              
              const responseData = await res.json();
              if (responseData.url) {
                  // Redirect to Stripe checkout
                  window.location.href = responseData.url;
              } else {
                  throw new Error("No checkout URL received from server");
              }
          } catch (err) {
              console.error("Failed to initiate checkout:", err);
              alert("Error: " + (err.message || "Failed to initiate checkout. Please try again."));
              // Reset button state
              subscribeButton.disabled = false;
              subscribeButton.textContent = "Upgrade";
          }
      });
      
      // Listen for Supabase auth state changes (login/logout)
      window.supabase.auth.onAuthStateChange(async (event, session) => {
          console.log("Auth state change:", event);
          
          if (event === 'SIGNED_IN' && session) {
              authToken = session.access_token;
              console.log("✅ User signed in:", session.user.email);
              
              // Upsert user profile in Supabase
              try {
                  await window.supabase.from('users').upsert({ 
                      id: session.user.id, 
                      email: session.user.email,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString()
                  }, { onConflict: 'id' });
                  
                  // Check subscription status using the API
                  let subscribed = false;
                  try {
                      const response = await fetch('/api/subscription-check', {
                          headers: {
                              'Authorization': `Bearer ${authToken}`
                          }
                      });
                      
                      if (response.ok) {
                          const result = await response.json();
                          subscribed = result.isSubscribed || false;
                      }
                  } catch (err) {
                      console.error("Error checking subscription:", err);
                      
                      // Fallback to database query
                      const { data: profile } = await window.supabase.from('users')
                          .select('is_subscribed')
                          .eq('id', session.user.id)
                          .single();
                          
                      subscribed = profile?.is_subscribed || false;
                  }
                  
                  // Show chat UI
                  userEmail.textContent = session.user.email;
                  loginArea.style.display = "none";
                  appContainer.style.display = "block";
                  userInfo.style.display = "flex";
                  logoutButton.style.display = "inline-block";
                  subscribeButton.style.display = subscribed ? "none" : "inline-block";
                  
                  // Update UI based on subscription status
                  updateUIForSubscription(subscribed);
                  
                  // Add debug button for admins
                  addDebugButton();
                  
                  // Add debug refresh button
                  addDebugRefreshButton();
                  
                  // FIXED: Always load user's chats from database regardless of subscription
                  await renderChatHistory();
                  
                  // Display initial message if no chats are loaded
                  if (messagesContainer.children.length === 0) {
                      appendMessage("Hellooo!! 👋 I'm panther ai. What can I help you build today?", "bot");
                  }
                  
              } catch (error) {
                  console.error("Error updating user profile:", error);
              }
          } else if (event === 'SIGNED_OUT') {
              authToken = null;
              appContainer.style.display = "none";
              loginArea.style.display = "flex";
              userInfo.style.display = "none";
              // Remove debug buttons
              if (document.getElementById('refresh-chats-btn')) {
                  document.getElementById('refresh-chats-btn').remove();
              }
          }
      });
  
      // Delete current chat button
      deleteChatButton.addEventListener("click", async () => {
          if (!confirm("Are you sure you want to delete this chat? This action cannot be undone.")) return;
          
          // Refresh token before making the request
          const { data: sessionData } = await window.supabase.auth.getSession();
          authToken = sessionData.session?.access_token;
          
          if (!authToken) {
              alert("Authentication error. Please refresh the page and try again.");
              return;
          }
          
          const currentSessionId = localStorage.getItem("sessionId");
          if (!currentSessionId) return;
          
          try {
              const baseUrl = API_BASE_URL.replace('/chat', '');
              const res = await fetch(`${baseUrl}/chat/${currentSessionId}`, {
                  method: "DELETE",
                  headers: { "Authorization": `Bearer ${authToken}` }
              });
              if (!res.ok) throw new Error("Delete failed");
              // Clear UI and reset session
              messagesContainer.innerHTML = "";
              localStorage.removeItem("sessionId");
              const newSessionId = getSessionId();
              console.log("✅ Chat deleted. New session:", newSessionId);
              appendMessage("Hellooo!! 👋 I'm panther ai. What can I help you build today?", "bot");
              
              // Refresh chat history in sidebar
              await renderChatHistory();
          } catch (err) {
              console.error(err);
              alert("Failed to delete chat. Please try again.");
          }
      });
  
      // Cancel streaming on stop button
      cancelStreamBtn.addEventListener("click", function() {
          if (activeStream) {
              cancelActiveStream();
              streamControls.classList.remove("active");
          }
      });
  
      // File upload button
      uploadFileBtn.addEventListener("click", () => {
          fileInput.click();
      });
      fileInput.addEventListener("change", (e) => {
          if (e.target.files.length > 0) {
              handleFileSelection(e.target.files);
          }
      });
      // Drag-and-drop file support
      inputContainer.addEventListener("dragover", (e) => {
          e.preventDefault();
          inputContainer.classList.add("drag-over");
      });
      inputContainer.addEventListener("dragleave", () => {
          inputContainer.classList.remove("drag-over");
      });
      inputContainer.addEventListener("drop", (e) => {
          e.preventDefault();
          inputContainer.classList.remove("drag-over");
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              handleFileSelection(e.dataTransfer.files);
              e.dataTransfer.clearData();
          }
      });
  
      // PRD editor open/close
      if (openCanvasBtn) {
          openCanvasBtn.addEventListener("click", () => {
              prdEditorPanel.classList.toggle("open");
          });
      }
      closeEditorBtn.addEventListener("click", () => {
          prdEditorPanel.classList.remove("open");
      });
      copyEditorBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(prdContent.innerText).then(() => {
              copyEditorBtn.innerText = "Copied!";
              setTimeout(() => {
                  copyEditorBtn.innerHTML = `
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                  `;
              }, 2000);
          }).catch(err => {
              console.error('Failed to copy text: ', err);
          });
      });
      prdContent.addEventListener("input", function() {
          currentPrd = prdContent.innerHTML;
          localStorage.setItem("currentPrd", currentPrd);
      });
  
      // Cancel active stream function
      function cancelActiveStream() {
          if (activeStream && streamController) {
              streamController.abort();
              activeStream = false;
          }
      }
  
      // Add new chat button functionality
      newChatBtn.addEventListener("click", function() {
          // Clear messages and create new session
          messagesContainer.innerHTML = "";
          localStorage.removeItem("sessionId");
          const newSessionId = getSessionId();
          chatTitle.textContent = "New Chat";
          console.log("✅ New chat session created:", newSessionId);
          // Add welcome message
          appendMessage("Hellooo!! 👋 I'm panther ai. What can I help you build today?", "bot");
          
          // Clear any PRD content
          currentPrd = "";
          prdContent.innerHTML = "";
      });
  
      // Format timestamp for chat history
      function formatTimestamp(date) {
          const now = new Date();
          const yesterday = new Date(now);
          yesterday.setDate(now.getDate() - 1);
          
          const isToday = date.toDateString() === now.toDateString();
          const isYesterday = date.toDateString() === yesterday.toDateString();
          
          if (isToday) {
              return `Today, ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
          } else if (isYesterday) {
              return `Yesterday, ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
          } else {
              return `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
          }
      }
  
      // Modified function to update chat history in sidebar
      async function updateChatHistory(sessionId, title, timestamp) {
          // Still save to localStorage as a fallback
          let chatHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
          
          // Check if this session already exists
          const existingIndex = chatHistory.findIndex(chat => chat.id === sessionId);
          
          if (existingIndex >= 0) {
              // Update existing chat
              chatHistory[existingIndex].title = title;
              chatHistory[existingIndex].timestamp = timestamp;
          } else {
              // Add new chat
              chatHistory.unshift({
                  id: sessionId,
                  title: title,
                  timestamp: timestamp
              });
          }
          
          // Keep only last 10 chats in localStorage
          chatHistory = chatHistory.slice(0, 10);
          localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
          
          // Refresh the UI by fetching from database
          await renderChatHistory();
      }
  
      // FIXED: Modified renderChatHistory function to work regardless of subscription
      async function renderChatHistory() {
          console.log("Rendering chat history in sidebar");
          const currentSessionId = getSessionId();
          
          // FIXED: Separate auth check from fetching chats
          const { data: sessionData } = await window.supabase.auth.getSession();
          if (!sessionData || !sessionData.session) {
              console.log("User not logged in, cannot render chat history");
              return;
          }
          
          // FIXED: Fetch chats directly from database for all users, regardless of subscription
          try {
              const userId = sessionData.session.user.id;
              const { data: chats, error } = await window.supabase
                  .from('chats')
                  .select('id, messages, created_at')
                  .eq('user_id', userId)
                  .order('created_at', { ascending: false });
                  
              if (error) {
                  console.error("Error fetching user chats:", error);
                  return;
              }
              
              console.log(`Found ${chats?.length || 0} chats for user ${userId}`);
              
              // Process chats for display
              const userChats = chats.map(chat => {
                  // Extract title from first user message
                  let title = "New Chat";
                  if (chat.messages && Array.isArray(chat.messages) && chat.messages.length > 0) {
                      const firstUserMsg = chat.messages.find(m => m.role === "user");
                      if (firstUserMsg) {
                          title = firstUserMsg.content.length > 30 ? 
                              firstUserMsg.content.substring(0, 30) + "..." : 
                              firstUserMsg.content;
                      }
                  }
                  
                  return {
                      id: chat.id,
                      title: title,
                      timestamp: chat.created_at
                  };
              });
              
              // Update localStorage with these chats for persistence
              localStorage.setItem("chatHistory", JSON.stringify(userChats));
              
              // Render in sidebar
              chatsContainer.innerHTML = "";
              
              userChats.forEach(chat => {
                  const chatItem = document.createElement("div");
                  chatItem.className = "chat-item";
                  if (chat.id === currentSessionId) {
                      chatItem.classList.add("active");
                  }
                  
                  const chatTimeStr = formatTimestamp(new Date(chat.timestamp));
                  
                  // Create icon element (for collapsed view)
                  const chatIcon = document.createElement("div");
                  chatIcon.className = "chat-icon";
                  const firstLetter = (chat.title || "C").charAt(0).toUpperCase();
                  chatIcon.textContent = firstLetter;
                  
                  // Create info element (for expanded view)
                  const chatInfo = document.createElement("div");
                  chatInfo.className = "chat-info";
                  chatInfo.innerHTML = `
                      <div class="chat-title">${chat.title}</div>
                      <div class="chat-time">${chatTimeStr}</div>
                  `;
                  
                  chatItem.appendChild(chatIcon);
                  chatItem.appendChild(chatInfo);
                  
                  // FIXED: Use a proper click handler that doesn't refresh the page
                  chatItem.addEventListener("click", function(e) {
                      // This is crucial to prevent page refresh!
                      e.preventDefault();
                      e.stopPropagation();
                      
                      console.log(`Chat item clicked: ${chat.id}`);
                      
                      if (chat.id === currentSessionId) {
                          console.log("Already on this chat, ignoring click");
                          return;
                      }
                      
                      // Show loading state
                      chatItem.style.opacity = "0.6";
                      chatItem.style.pointerEvents = "none";
                      
                      // Switch session ID in localStorage
                      localStorage.setItem("sessionId", chat.id);
                      
                      // Update active state in UI
                      document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
                      chatItem.classList.add('active');
                      
                      // Load chat history from database
                      loadChatHistory(chat.id).then(success => {
                          // Reset loading state
                          chatItem.style.opacity = "1";
                          chatItem.style.pointerEvents = "auto";
                          
                          console.log(`Chat ${chat.id} loaded:`, success);
                          
                          if (!success) {
                              // If loading failed, show a message
                              messagesContainer.innerHTML = "";
                              appendMessage("Could not load chat history. Please try refreshing the page.", "bot");
                          }
                      }).catch(err => {
                          console.error("Error loading chat:", err);
                          chatItem.style.opacity = "1";
                          chatItem.style.pointerEvents = "auto";
                          
                          messagesContainer.innerHTML = "";
                          appendMessage("Error loading chat: " + err.message, "bot");
                      });
                  });
                  
                  chatsContainer.appendChild(chatItem);
              });
              
          } catch (error) {
              console.error("Error in renderChatHistory:", error);
          }
      }
  
      // Append a message to the chat (sanitize and parse Markdown for bot messages)
      function appendMessage(text, sender) {
          const messageDiv = document.createElement("div");
          messageDiv.classList.add("message", sender);
          
          // Handle both "bot" and "assistant" roles as bot messages
          if (sender === "bot" || sender === "assistant") {
              // Always apply the "bot" class for styling consistency
              messageDiv.classList.remove("assistant");
              messageDiv.classList.add("bot");
              
              // Parse markdown and sanitize for bot/assistant messages
              messageDiv.innerHTML = "<div class='message-content'>" + marked.parse(DOMPurify.sanitize(text)) + "</div>";
          } else {
              // Regular handling for user messages
              messageDiv.innerHTML = "<div class='message-content'>" + DOMPurify.sanitize(text) + "</div>";
          }
          
          messagesContainer.appendChild(messageDiv);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
  
      // Chat history debugging tools
      window.diagnoseChatIssue = async function() {
        try {
          console.group("🔍 CHAT HISTORY DIAGNOSIS");
          const sessionId = localStorage.getItem("sessionId");
          console.log("Current session ID:", sessionId);
          
          // Check auth status
          const { data: sessionData } = await window.supabase.auth.getSession();
          console.log("Auth status:", sessionData?.session ? "Logged in" : "Not logged in");
          
          if (!sessionData?.session) {
            console.error("Not logged in - chat history won't load");
            console.groupEnd();
            return { error: "Not logged in" };
          }
          
          // Check if this chat exists in database
          const { data: chat, error: chatError } = await window.supabase
            .from('chats')
            .select('*')
            .eq('id', sessionId)
            .maybeSingle();
            
          if (chatError) {
            console.error("Error fetching chat:", chatError);
            console.groupEnd();
            return { error: chatError };
          }
          
          console.log("Chat found in database:", !!chat);
          
          if (!chat) {
            console.error("Chat not found in database");
            console.groupEnd();
            return { error: "Chat not found" };
          }
          
          // Check message structure
          console.log("Messages data type:", typeof chat.messages);
          console.log("Is messages an array?", Array.isArray(chat.messages));
          console.log("Messages length:", chat.messages?.length || 0);
          
          if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
            console.error("Messages array empty or invalid");
            console.groupEnd();
            return { error: "No messages" };
          }
          
          // Check first few messages
          const sampleMessages = chat.messages.slice(0, 3);
          console.log("Sample messages:", sampleMessages);
          
          // Check for role property in messages
          const missingRoleMessages = chat.messages.filter(m => !m.role);
          if (missingRoleMessages.length > 0) {
            console.error("Some messages are missing the 'role' property:", missingRoleMessages);
          }
          
          // Check for content property in messages
          const missingContentMessages = chat.messages.filter(m => !m.content);
          if (missingContentMessages.length > 0) {
            console.error("Some messages are missing the 'content' property:", missingContentMessages);
          }
          
          // Check role values
          const roles = [...new Set(chat.messages.map(m => m.role))];
          console.log("Unique role values found:", roles);
          
          // Check if we have 'assistant' roles that need to be displayed as 'bot'
          const hasAssistantRoles = chat.messages.some(m => m.role === "assistant");
          if (hasAssistantRoles) {
            console.warn("Found messages with 'assistant' role - these need to be mapped to 'bot' for display");
          }
          
          // Try to manually display the first user and assistant message
          try {
            console.log("Attempting to manually display the first messages:");
            const userMsg = chat.messages.find(m => m.role === "user");
            const assistantMsg = chat.messages.find(m => m.role === "assistant");
            
            if (userMsg) {
              console.log(`User message: ${userMsg.content.substring(0, 50)}${userMsg.content.length > 50 ? '...' : ''}`);
            }
            
            if (assistantMsg) {
              console.log(`Assistant message: ${assistantMsg.content.substring(0, 50)}${assistantMsg.content.length > 50 ? '...' : ''}`);
            }
          } catch (err) {
            console.error("Error displaying messages:", err);
          }
          
          console.groupEnd();
          return { 
            success: true, 
            sessionId,
            chatFound: !!chat,
            messageCount: chat.messages?.length || 0,
            roles
          };
        } catch (err) {
          console.error("Error in diagnoseChatIssue:", err);
          console.groupEnd();
          return { error: err.message };
        }
      };
  
      // Add a function to fix common chat issues
      window.fixChatRoles = async function() {
        try {
          const sessionId = localStorage.getItem("sessionId");
          if (!sessionId) {
            console.error("No sessionId found");
            return { error: "No sessionId" };
          }
          
          const { data: chat, error } = await window.supabase
            .from('chats')
            .select('messages, id')
            .eq('id', sessionId)
            .single();
            
          if (error || !chat) {
            console.error("Error fetching chat:", error);
            return { error: error?.message || "Chat not found" };
          }
          
          if (!Array.isArray(chat.messages)) {
            console.error("Messages is not an array");
            return { error: "Invalid messages format" };
          }
          
          // No changes needed, just reload
          return await loadChatHistory(sessionId);
        } catch (err) {
          console.error("Error in fixChatRoles:", err);
          return { error: err.message };
        }
      };
  
      // Send a message to the backend (with streaming response)
      async function sendMessage() {
  
          retryCount = 0;  // Add this line to reset the retry counter
  
          const userMessage = userInput.value.trim();
          if (!userMessage && uploadedFiles.length === 0) {
              console.error("🚨 No message or files provided");
              return;
          }
          
          // Make sure we have the latest token
          const { data: sessionData } = await window.supabase.auth.getSession();
          authToken = sessionData.session?.access_token;
          
          if (!authToken) {
              console.error("No authentication token available");
              appendMessage("Error: You need to be logged in to send messages. Please refresh the page and try again.", "bot");
              return;
          }
          
          // Update chat title if it's the first message
          if (messagesContainer.querySelectorAll(".message.user").length === 0) {
              const newTitle = userMessage.length > 30 ? 
                  userMessage.substring(0, 30) + "..." : 
                  userMessage;
              chatTitle.textContent = newTitle;
              await updateChatHistory(getSessionId(), newTitle, new Date());
          }
          
          // Display the user's message in the chat (show attached file names if any)
          let displayMessage = userMessage;
          const fileAttachments = uploadedFiles.length > 0 ? 
              `<div class="attached-files">
                  ${uploadedFiles.map(file => {
                      let fileIcon = "📄";
                      if (file.type.startsWith("image/")) fileIcon = "🖼️";
                      else if (file.type.includes("pdf")) fileIcon = "📑";
                      else if (file.type.includes("spreadsheet") || file.type.includes("excel")) fileIcon = "📊";
                      else if (file.type.includes("presentation") || file.type.includes("powerpoint")) fileIcon = "📋";
                      return `<div class="attached-file">
                          <span class="file-icon">${fileIcon}</span>
                          <span class="file-name">${file.name}</span>
                      </div>`;
                  }).join('')}
              </div>` : '';
          appendMessage(displayMessage + (fileAttachments ? "\n" + fileAttachments : ""), "user");
          userInput.value = "";
          // Reset textarea height and re-enable send button after stream
          userInput.style.height = '36px';
          sendButton.disabled = true;
          // Use streaming API endpoint
          const apiUrl = API_STREAM_URL;
          streamControls.classList.add("active");
  
          try {
              // Check if user is trying to use a premium model
              const isPremiumModel = premiumModels.some(pm => selectedModel.toLowerCase().includes(pm));
              
              // If trying to use premium model but not subscribed, force subscription check
              if (isPremiumModel && !userIsSubscribed) {
                  console.log("Premium model selected but user not marked as subscribed. Rechecking subscription...");
                  const actuallySubscribed = await refreshSubscriptionStatus();
                  if (!actuallySubscribed) {
                      // Try forcing subscription if API check fails
                      if (retryCount < MAX_RETRIES) {
                          retryCount++;
                          const forceSuccess = await forceSubscriptionUpdate();
                          if (forceSuccess) {
                              userIsSubscribed = true;
                              // Continue with premium model
                          } else {
                              // Fall back to non-premium model
                              console.log("User not subscribed, falling back to non-premium model");
                              selectedModel = "gpt-3.5-turbo";
                              if (modelSelect) modelSelect.value = selectedModel;
                              localStorage.setItem("selectedModel", selectedModel);
                          }
                      } else {
                          // Max retries exceeded, fall back to non-premium model
                          selectedModel = "gpt-3.5-turbo";
                          if (modelSelect) modelSelect.value = selectedModel;
                          localStorage.setItem("selectedModel", selectedModel);
                      }
                  } else {
                      userIsSubscribed = true;
                      // Continue with premium model as user is subscribed
                  }
              }
              
              // Prepare fetch options (FormData if files attached, otherwise JSON)
              let fetchOptions = { method: "POST" };
              if (uploadedFiles.length > 0) {
                  const formData = new FormData();
                  formData.append("sessionId", getSessionId());
                  formData.append("message", userMessage);
                  formData.append("model", selectedModel);
                  uploadedFiles.forEach((file, index) => {
                      formData.append(`file${index}`, file);
                  });
                  fetchOptions.body = formData;
                  fetchOptions.headers = {};
                  if (authToken) {
                      fetchOptions.headers["Authorization"] = `Bearer ${authToken}`;
                      console.log("Using auth token for form data request:", authToken.substring(0, 10) + "...");
                  }
                  // Clear selected files after sending
                  uploadedFiles = [];
                  updateFilesListUI();
              } else {
                  const requestBody = {
                      sessionId: getSessionId(),
                      message: userMessage,
                      model: selectedModel
                  };
                  console.log("📡 Sending streaming request:", JSON.stringify(requestBody, null, 2));
                  fetchOptions.headers = { 
                      "Content-Type": "application/json",
                      "Authorization": `Bearer ${authToken}`
                  };
                  console.log("Using auth token for JSON request:", authToken.substring(0, 10) + "...");
                  fetchOptions.body = JSON.stringify(requestBody);
              }
              // Enable stream cancellation
              streamController = new AbortController();
              fetchOptions.signal = streamController.signal;
              // Send request and stream the response
              const response = await fetch(apiUrl, fetchOptions);
              if (!response.ok) {
                  throw new Error(`Server responded with status: ${response.status}`);
              }
              // Create container for incoming bot response
              const messageDiv = document.createElement("div");
              messageDiv.classList.add("message", "bot");
              const messageContent = document.createElement("div");
              messageContent.classList.add("message-content");
              messageDiv.appendChild(messageContent);
              messagesContainer.appendChild(messageDiv);
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
              activeStream = true;
              // Read the SSE stream
              const reader = response.body.getReader();
              const decoder = new TextDecoder("utf-8");
              let done = false;
              let fullReply = "";
              while (!done) {
                  const { value, done: doneReading } = await reader.read();
                  done = doneReading;
                  const chunkValue = decoder.decode(value);
                  if (chunkValue) {
                      try {
                          // Each SSE "data: " chunk contains JSON
                          const dataChunks = chunkValue.split("data: ");
                          for (let i = 1; i < dataChunks.length; i++) {
                              const parsed = JSON.parse(dataChunks[i]);
                              if (parsed.error) {
                                  throw new Error(parsed.error);
                              }
                              if (parsed.chunk) {
                                  fullReply += parsed.chunk;
                                  messageContent.innerHTML = marked.parse(fullReply);
                              } else if (parsed.done) {
                                  // end of message
                              }
                          }
                      } catch (err) {
                          console.error("Stream parse error:", err);
                      }
                  }
              }
              
              activeStream = false;
              streamControls.classList.remove("active");
              sendButton.disabled = false;
              // Auto-scroll to bottom after receiving full reply
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
              
              // FIXED: Always refresh chat sidebar after successfully sending a message
              // This ensures non-subscribed users also see their updated chat list
              await renderChatHistory();
          } catch (error) {
              activeStream = false;
              streamControls.classList.remove("active");
              sendButton.disabled = false;
              console.error("Error sending message:", error);
              // Enhanced error logging
              console.error("Error sending message:", error);
              console.error("Selected model when error occurred:", selectedModel);
              console.error("User is subscribed:", userIsSubscribed);
              // Show the error to the user
              appendMessage("Error sending message with " + selectedModel + ": " + error.message + ". Try using a different model or refreshing the page.", "bot");
              // Add a helpful button to reset
              const resetButton = document.createElement("button");
              resetButton.textContent = "Reset Model to GPT-3.5";
              resetButton.style.marginTop = "10px";
              resetButton.style.padding = "5px 10px";
              resetButton.style.backgroundColor = "var(--accent-primary)";
              resetButton.style.color = "white";
              resetButton.style.border = "none";
              resetButton.style.borderRadius = "4px";
              resetButton.style.cursor = "pointer";
              resetButton.onclick = () => {
                  // Reset to GPT-3.5
                  selectedModel = "gpt-3.5-turbo";
                  if (modelSelect) modelSelect.value = selectedModel;
                  localStorage.setItem("selectedModel", selectedModel);
                  resetButton.remove();
                  appendMessage("Model reset to GPT-3.5. You can try sending a message now.", "bot");
              };
              messagesContainer.lastChild.appendChild(resetButton);
  
          }
      }
  
      // Handle file selection from input or drag-drop
      function handleFileSelection(files) {
          for (const file of files) {
              uploadedFiles.push(file);
          }
          updateFilesListUI();
      }
      
      // Update the UI list of selected files
      function updateFilesListUI() {
          const filesListContainer = document.getElementById("filesList");
          if (!filesListContainer) return;
          filesListContainer.innerHTML = "";
          if (uploadedFiles.length > 0) {
              filesListContainer.style.display = "block";
              uploadedFiles.forEach(file => {
                  const fileItem = document.createElement("div");
                  fileItem.className = "selected-file";
                  fileItem.textContent = file.name;
                  filesListContainer.appendChild(fileItem);
              });
          } else {
              filesListContainer.style.display = "none";
          }
      }
      
      // Generate or retrieve a persistent sessionId for the conversation
      function getSessionId() {
          let sessionId = localStorage.getItem("sessionId");
          if (!sessionId || sessionId === "null") {
              sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              localStorage.setItem("sessionId", sessionId);
          }
          return sessionId;
      }
      
      // Ensure a sessionId is set on load and load messages
      const sessionId = getSessionId();
      console.log("✅ Stored Session ID:", sessionId);
      
      // FIXED: Load chat history for all users, not just subscribers
      if (session && session.user) {
          // First load all user's chats for the sidebar
          renderChatHistory().then(() => {
              // Then load the current chat
              loadChatHistory(sessionId).then(success => {
                  // If no chat history was loaded, show welcome message
                  if (!success || messagesContainer.children.length === 0) {
                      appendMessage("Hellooo!! 👋 I'm panther ai. What can I help you build today?", "bot");
                  }
              });
          });
      } else {
          // The welcome message will be shown after login instead
      }
  
      // Send message on clicking the send button or pressing Enter
      sendButton.addEventListener("click", () => {
          if (activeStream) {
              cancelActiveStream();
          }
          sendMessage();
      });
      
      userInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (activeStream) {
                  cancelActiveStream();
              }
              sendMessage();
          }
      });
      
      // Debug function to test authentication
      window.testAuth = async function() {
          try {
              const { data: testSessionData } = await window.supabase.auth.getSession();
              const currentToken = testSessionData.session?.access_token;
              
              if (!currentToken) {
                  console.log("No auth token available");
                  return;
              }
              
              if (currentToken) {
                  // Check if token contains any special characters
                  const hasSpecialChars = /[^A-Za-z0-9._-]/.test(currentToken);
                  console.log("Token contains special characters:", hasSpecialChars);
                  console.log("Token starts with:", currentToken.substring(0, 20));
                  console.log("Token ends with:", currentToken.substring(currentToken.length - 20));
              }
              console.log("Current token (first 15 chars):", currentToken.substring(0, 15) + "...");
              
              const response = await fetch("/api/auth-check", {
                  headers: {
                      "Authorization": `Bearer ${currentToken}`
                  }
              });
              
              const result = await response.json();
              console.log("Auth check result:", result);
          } catch (err) {
              console.error("Auth test error:", err);
          }
      };
  
      // Debug function to manually check subscription status
      window.checkSubscription = async function() {
          try {
              console.log("Manually checking subscription status...");
              // Try direct API check first
              const response = await fetch('/api/subscription-check', {
                  headers: {
                      'Authorization': `Bearer ${authToken}`
                  }
              });
              
              const apiResult = await response.json();
              console.log("API subscription check result:", apiResult);
              
              // Then check database
              const isSubscribed = await refreshSubscriptionStatus();
              console.log("Database subscription check result:", isSubscribed);
              
              // Try to force update if not subscribed
              if (!isSubscribed && !apiResult.isSubscribed) {
                  console.log("Attempting to force update subscription...");
                  const forceResult = await forceSubscriptionUpdate();
                  console.log("Force update result:", forceResult);
                  
                  if (forceResult) {
                      alert("Subscription status forced to active!");
                      return true;
                  }
              }
              
              alert("Subscription status: " + (isSubscribed || apiResult.isSubscribed ? "Active" : "Not active"));
              return isSubscribed || apiResult.isSubscribed;
          } catch (err) {
              console.error("Error checking subscription:", err);
              alert("Error checking subscription: " + err.message);
              return false;
          }
      };
  
      // Debug function to enable premium models directly (for testing)
      window.enablePremiumModels = function() {
          if (modelSelect) {
              for (let opt of modelSelect.options) {
                  if (premiumModels.some(pm => opt.value.toLowerCase().includes(pm))) {
                      opt.disabled = false;
                      opt.textContent = opt.textContent.replace(" (Premium)", "");
                  }
              }
              console.log("Premium models enabled manually for testing.");
              userIsSubscribed = true;
              return true;
          }
          return false;
      };
  
      // Debug function to test Gemini API
      window.testGeminiAPI = async function() {
          try {
              console.log("Testing Gemini API directly...");
              const response = await fetch('/api/test-gemini-direct');
              const result = await response.json();
              console.log("Gemini API test result:", result);
              alert(result.success ? "Gemini API working!" : "Gemini API error: " + (result.error || "Unknown error"));
              return result;
          } catch (err) {
              console.error("Error testing Gemini API:", err);
              alert("Error testing Gemini API: " + err.message);
              return null;
          }
      };
      
      // Debug function to test Claude API
      window.testClaudeAPI = async function() {
          try {
              console.log("Testing Claude API directly...");
              const response = await fetch('/api/test-claude-direct');
              const result = await response.json();
              console.log("Claude API test result:", result);
              alert(result.success ? "Claude API working!" : "Claude API error: " + (result.error || "Unknown error"));
              return result;
          } catch (err) {
              console.error("Error testing Claude API:", err);
              alert("Error testing Claude API: " + err.message);
              return null;
          }
      };
  
      // Debug function to test Grok API
      window.testGrokAPI = async function() {
          try {
              console.log("Testing Grok API directly...");
              const response = await fetch('/api/test-grok-direct');
              const result = await response.json();
              console.log("Grok API test result:", result);
              alert(result.success ? "Grok API working!" : "Grok API error: " + (result.error || "Unknown error"));
              return result;
          } catch (err) {
              console.error("Error testing Grok API:", err);
              alert("Error testing Grok API: " + err.message);
              return null;
          }
      };
  
  });