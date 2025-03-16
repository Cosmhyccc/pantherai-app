import serverApp from '../backend/server.js';

export default function handler(req, res) {
  // Set path to match the specific endpoint
  req.url = '/api/subscription-check';
  // Pass to your Express app
  return serverApp(req, res);
}