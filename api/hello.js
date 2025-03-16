// Simple test endpoint that doesn't depend on your server.js
export default function handler(req, res) {
    res.status(200).json({ 
      message: "API endpoint reached", 
      time: new Date().toISOString(),
      query: req.query
    });
  }