import express from 'express';
import serverApp from '../backend/server.js';

// Export a handler function for Vercel serverless functions
export default function handler(req, res) {
  // Forward the request to your Express app
  return serverApp(req, res);
}