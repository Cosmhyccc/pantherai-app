import fs from 'fs';
import path from 'path';

/**
 * Process uploaded files and organize them by session
 * 
 * @param {Array} files - Array of uploaded files
 * @param {String} sessionId - Session identifier
 * @param {Map} sessionFilesMap - Map to store file information by session
 * @returns {Array} Array of processed file information
 */
export function processUploadedFiles(files, sessionId, sessionFilesMap) {
    // Log all files being processed for debugging
    console.log(`Processing ${files?.length || 0} uploads for session ${sessionId}`);
    if (files && files.length > 0) {
        console.log("File types:", files.map(f => f.mimetype).join(', '));
    }
    
    if (!files || files.length === 0) return [];
    
    // Validate sessionId
    if (!sessionId) {
        console.error("Missing sessionId in processUploadedFiles");
        sessionId = 'unknown-' + Date.now();
    }
    
    // Make sure the session map is initialized
    if (!sessionFilesMap.has(sessionId)) {
        sessionFilesMap.set(sessionId, []);
    }
    
    const filesList = sessionFilesMap.get(sessionId);
    
    // Process each file with error handling
    return files.map(file => {
        try {
            // Basic validation
            if (!file || !file.path) {
                console.error("Invalid file object:", file);
                return null;
            }
            
            // Check if file exists on disk
            if (!fs.existsSync(file.path)) {
                console.error(`File doesn't exist on disk: ${file.path}`);
                return null;
            }
            
            const fileInfo = {
                filename: file.filename || ('file-' + Date.now()),
                originalName: file.originalname || 'unknown',
                mimetype: file.mimetype || 'application/octet-stream',
                size: file.size || 0,
                path: file.path
            };
            
            filesList.push(fileInfo);
            return fileInfo;
        } catch (error) {
            console.error(`Error processing file ${file?.originalname || 'unknown'}:`, error);
            return null;
        }
    }).filter(file => file !== null); // Remove any failed files
}

/**
 * Read content from a text file
 * 
 * @param {String} filePath - Path to the file
 * @returns {Promise<String>} Content of the file
 */
export async function readFileContent(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(`File doesn't exist: ${filePath}`);
            return null;
        }
        
        // Check file size before reading
        const stats = await fs.promises.stat(filePath);
        if (stats.size > 1024 * 1024) { // 1MB limit for text files
            console.warn(`File too large for full read (${stats.size} bytes): ${filePath}`);
            // Read just the first 100KB for large files
            const buffer = Buffer.alloc(100 * 1024);
            const fd = await fs.promises.open(filePath, 'r');
            await fd.read(buffer, 0, 100 * 1024, 0);
            await fd.close();
            const content = buffer.toString('utf8');
            return content + '\n\n... [Content truncated due to size] ...';
        }
        
        const content = await fs.promises.readFile(filePath, 'utf8');
        return content;
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return null;
    }
}

/**
 * Convert a file to base64 data URL format
 * 
 * @param {String} filePath - Path to the file
 * @param {String} mimeType - MIME type of the file
 * @returns {Promise<String>} Data URL representation of the file
 */
export async function fileToDataURL(filePath, mimeType) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(`File doesn't exist for dataURL conversion: ${filePath}`);
            return null;
        }
        
        // Check file size to prevent memory issues
        const stats = await fs.promises.stat(filePath);
        console.log(`Converting file to dataURL: ${filePath}, size: ${stats.size} bytes`);
        
        if (stats.size > 10 * 1024 * 1024) { // 10MB limit
            console.error(`File too large for dataURL conversion (${stats.size} bytes): ${filePath}`);
            return null;
        }
        
        const fileBuffer = await fs.promises.readFile(filePath);
        const base64Data = fileBuffer.toString('base64');
        return `data:${mimeType || 'application/octet-stream'};base64,${base64Data}`;
    } catch (error) {
        console.error(`Error converting file to data URL: ${filePath}`, error);
        return null;
    }
}

/**
 * Prepare Claude-specific image format (direct implementation)
 * 
 * @param {Array} files - Array of image files
 * @returns {Promise<Array>} Array of Claude-formatted image objects
 */
export async function prepareClaudeImages(files) {
    console.log(`Preparing ${files?.length || 0} images specifically for Claude`);
    
    if (!files || files.length === 0) return [];
    
    // Filter to ensure we only process image files with error handling
    const imageFiles = files.filter(file => {
        try {
            return file && file.mimetype && file.mimetype.startsWith('image/') && fs.existsSync(file.path);
        } catch (error) {
            console.error(`Error checking image file: ${file?.path}`, error);
            return false;
        }
    });
    
    if (imageFiles.length === 0) {
        console.log("No valid image files found for Claude");
        return [];
    }
    
    console.log(`Processing ${imageFiles.length} valid images for Claude`);
    
    try {
        const results = await Promise.all(imageFiles.map(async (file) => {
            try {
                console.log(`Reading Claude image file: ${file.path}`);
                
                // Get file stats
                const stats = await fs.promises.stat(file.path);
                console.log(`File size: ${stats.size} bytes`);
                
                // Check file size limits for Claude (usually 10MB per image)
                if (stats.size > 10 * 1024 * 1024) {
                    console.error(`File too large for Claude (${stats.size} bytes): ${file.path}`);
                    return null;
                }
                
                // Read file as binary
                const fileBuffer = await fs.promises.readFile(file.path);
                console.log(`Successfully read file: ${file.path}, size: ${fileBuffer.length} bytes`);
                
                // Convert to base64
                const base64Data = fileBuffer.toString('base64');
                
                // Return in Claude's required format
                return {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: file.mimetype,
                        data: base64Data
                    }
                };
            } catch (error) {
                console.error(`Error processing image for Claude: ${file.path}`, error);
                return null;
            }
        }));
        
        // Filter out failed images
        const validResults = results.filter(item => item !== null);
        console.log(`Successfully processed ${validResults.length} images for Claude`);
        return validResults;
    } catch (error) {
        console.error("Failed to process images for Claude:", error);
        return [];
    }
}

/**
 * Prepare images in the format required by different AI models
 * 
 * @param {Array} files - Image files to process
 * @param {String} targetModel - The AI model ("claude", "openai", "gemini", "grok")
 * @returns {Promise<Array>} Processed image data in the format required by the model
 */
export async function prepareImagesForModel(files, targetModel) {
    console.log(`Preparing images for ${targetModel} model`);
    
    if (!files || files.length === 0) {
        console.log("No files provided to prepareImagesForModel");
        return [];
    }
    
    // Filter to ensure we only process image files with error handling
    const imageFiles = files.filter(file => {
        try {
            return file && file.mimetype && file.mimetype.startsWith('image/') && fs.existsSync(file.path);
        } catch (error) {
            console.error(`Error checking image file: ${file?.path}`, error);
            return false;
        }
    });
    
    console.log(`Found ${imageFiles.length} valid image files out of ${files.length} total files`);
    
    if (imageFiles.length === 0) return [];
    
    // For Claude, use the direct implementation which has more debugging
    if (targetModel.includes('claude')) {
        return await prepareClaudeImages(imageFiles);
    }
    
    try {
        // Process images based on the target model's requirements
        if (targetModel.includes('gemini')) {
            // Gemini requires a different format
            console.log("Processing images for Gemini format");
            return await Promise.all(imageFiles.map(async (file) => {
                try {
                    console.log(`Processing Gemini image: ${file.path}`);
                    
                    // Get file stats
                    const stats = await fs.promises.stat(file.path);
                    console.log(`File size: ${stats.size} bytes`);
                    
                    if (stats.size > 10 * 1024 * 1024) {
                        console.error(`File too large for Gemini (${stats.size} bytes): ${file.path}`);
                        return null;
                    }
                    
                    const fileBuffer = await fs.promises.readFile(file.path);
                    const base64Data = fileBuffer.toString('base64');
                    
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
        }
        else if (targetModel.includes('grok')) {
            // Process for Grok (similar to OpenAI)
            console.log("Processing images for Grok format");
            return await Promise.all(imageFiles.map(async (file) => {
                try {
                    console.log(`Processing Grok image: ${file.path}`);
                    
                    // Get file stats
                    const stats = await fs.promises.stat(file.path);
                    console.log(`File size: ${stats.size} bytes`);
                    
                    if (stats.size > 20 * 1024 * 1024) {
                        console.error(`File too large for Grok (${stats.size} bytes): ${file.path}`);
                        return null;
                    }
                    
                    const dataUrl = await fileToDataURL(file.path, file.mimetype);
                    if (!dataUrl) return null;
                    
                    console.log(`Successfully created dataURL for Grok, length: ${dataUrl.length}`);
                    
                    return {
                        type: "image_url",
                        image_url: { url: dataUrl }
                    };
                } catch (error) {
                    console.error(`Error processing image for Grok: ${file.path}`, error);
                    return null;
                }
            }));
        }
        else {
            // Default format for OpenAI models
            console.log("Processing images for OpenAI format");
            return await Promise.all(imageFiles.map(async (file) => {
                try {
                    console.log(`Processing OpenAI image: ${file.path}`);
                    
                    // Get file stats
                    const stats = await fs.promises.stat(file.path);
                    console.log(`File size: ${stats.size} bytes`);
                    
                    // Check size limit (OpenAI has a 20MB limit per request)
                    if (stats.size > 20 * 1024 * 1024) {
                        console.error(`File too large for OpenAI (${stats.size} bytes): ${file.path}`);
                        return null;
                    }
                    
                    const dataUrl = await fileToDataURL(file.path, file.mimetype);
                    if (!dataUrl) return null;
                    
                    console.log(`Successfully created dataURL for OpenAI, length: ${dataUrl.length}`);
                    
                    return {
                        type: "image_url",
                        image_url: { url: dataUrl }
                    };
                } catch (error) {
                    console.error(`Error processing image for OpenAI: ${file.path}`, error);
                    return null;
                }
            }));
        }
    } catch (error) {
        console.error("Error preparing images:", error);
        return [];
    }
}