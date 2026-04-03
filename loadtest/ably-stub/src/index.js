/**
 * Ably REST API Stub for Testing
 * 
 * Captures published events and supports fault injection:
 * - Delay: Add artificial latency to responses
 * - Drop: Randomly fail to respond
 * - Duplicate: Send duplicate responses
 * - Reorder: Reorder batched messages
 * - Error: Return HTTP errors
 * 
 * Captured events are written to /tmp/ably-captures/ for inspection
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync, appendFileSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const app = express();
const PORT = process.env.PORT || 8081;
const CAPTURE_DIR = process.env.CAPTURE_DIR || '/tmp/ably-captures';

// Fault injection configuration (can be changed via /admin/fault endpoint)
let faultConfig = {
  mode: 'none',  // none, delay, drop, duplicate, reorder, error
  delayMs: 0,
  errorRate: 0.0,  // 0.0 to 1.0
  dropRate: 0.0,
  duplicateRate: 0.0,
};

// Ensure capture directory exists
try {
  mkdirSync(CAPTURE_DIR, { recursive: true });
} catch (e) {
  console.error('Failed to create capture directory:', e);
}

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', faultMode: faultConfig.mode });
});

// Get current fault configuration
app.get('/admin/fault', (req, res) => {
  res.json(faultConfig);
});

// Set fault configuration
app.post('/admin/fault', (req, res) => {
  const { mode, delayMs, errorRate, dropRate, duplicateRate } = req.body;
  
  if (mode) faultConfig.mode = mode;
  if (typeof delayMs === 'number') faultConfig.delayMs = delayMs;
  if (typeof errorRate === 'number') faultConfig.errorRate = Math.max(0, Math.min(1, errorRate));
  if (typeof dropRate === 'number') faultConfig.dropRate = Math.max(0, Math.min(1, dropRate));
  if (typeof duplicateRate === 'number') faultConfig.duplicateRate = Math.max(0, Math.min(1, duplicateRate));
  
  console.log('Fault config updated:', faultConfig);
  res.json(faultConfig);
});

// Reset fault configuration
app.delete('/admin/fault', (req, res) => {
  faultConfig = {
    mode: 'none',
    delayMs: 0,
    errorRate: 0.0,
    dropRate: 0.0,
    duplicateRate: 0.0,
  };
  console.log('Fault config reset');
  res.json(faultConfig);
});

// Get captured events
app.get('/admin/captures', (req, res) => {
  const { channel, event } = req.query;

  try {
    const files = readdirSync(CAPTURE_DIR);
    let captures = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const content = readFileSync(join(CAPTURE_DIR, file), 'utf8');
      const data = JSON.parse(content);

      if (channel && data.channel !== channel) continue;
      if (event && data.event !== event) continue;

      captures.push(data);
    }

    // Sort by timestamp
    captures.sort((a, b) => a.timestamp - b.timestamp);

    res.json({ captures, count: captures.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clear captured events
app.delete('/admin/captures', (req, res) => {
  try {
    const files = readdirSync(CAPTURE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        unlinkSync(join(CAPTURE_DIR, file));
      }
    }
    res.json({ message: 'Captures cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ably REST API: Publish message to channel
// POST /channels/{channelName}/messages
app.post('/channels/:channelName/messages', (req, res) => {
  const { channelName } = req.params;
  const { name: eventName, data } = req.body;
  
  // Decode basic auth to get API key
  const authHeader = req.headers.authorization;
  let apiKey = null;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const [keyName, keySecret] = decoded.split(':');
    apiKey = { keyName, keySecret };
  }
  
  // Validate API key (for testing, just check format)
  if (!apiKey || !apiKey.keyName || !apiKey.keySecret) {
    return res.status(401).json({
      error: 'Invalid API key',
      code: 40100,
    });
  }
  
  // Apply fault injection
  const shouldApplyFault = Math.random() < (faultConfig.errorRate || faultConfig.dropRate || faultConfig.duplicateRate);
  
  // Check for drop fault
  if (faultConfig.mode === 'drop' || (shouldApplyFault && Math.random() < faultConfig.dropRate)) {
    console.log(`[FAULT] Dropping message to ${channelName}:${eventName}`);
    // Don't respond at all - simulate network timeout
    return;
  }
  
  // Check for error fault
  if (faultConfig.mode === 'error' || (shouldApplyFault && Math.random() < faultConfig.errorRate)) {
    console.log(`[FAULT] Returning error for ${channelName}:${eventName}`);
    return res.status(500).json({
      error: 'Internal server error (fault injection)',
      code: 50000,
    });
  }
  
  // Apply delay
  const delay = faultConfig.mode === 'delay' ? faultConfig.delayMs : faultConfig.delayMs;
  if (delay > 0) {
    console.log(`[FAULT] Delaying ${delay}ms for ${channelName}:${eventName}`);
  }
  
  // Create capture record
  const capture = {
    id: uuidv4(),
    timestamp: Date.now(),
    channel: channelName,
    event: eventName,
    data: data,
    apiKey: apiKey.keyName,
  };
  
  // Write capture to file
  const captureFile = join(CAPTURE_DIR, `${capture.id}.json`);
  writeFileSync(captureFile, JSON.stringify(capture, null, 2));
  
  console.log(`[CAPTURE] ${channelName}:${eventName} -> ${captureFile}`);
  
  // Send response after delay
  setTimeout(() => {
    res.json([{ id: capture.id, name: eventName, timestamp: capture.timestamp }]);
    
    // Apply duplicate fault (send response twice)
    if (faultConfig.mode === 'duplicate' || (shouldApplyFault && Math.random() < faultConfig.duplicateRate)) {
      console.log(`[FAULT] Sending duplicate response for ${channelName}:${eventName}`);
      setTimeout(() => {
        res.json([{ id: capture.id + '-dup', name: eventName, timestamp: Date.now() }]);
      }, 100);
    }
  }, delay);
});

// Ably REST API: Get channel stats (simplified)
app.get('/channels/:channelName', (req, res) => {
  const { channelName } = req.params;
  res.json({
    channelId: channelName,
    status: 'ACTIVE',
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Ably stub listening on port ${PORT}`);
  console.log(`Capture directory: ${CAPTURE_DIR}`);
  console.log(`Fault mode: ${faultConfig.mode}`);
});
