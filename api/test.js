export default function handler(req, res) {
    res.status(200).json({ 
      message: "API is working!", 
      environment: process.env.NODE_ENV,
      time: new Date().toISOString()
    });
  }