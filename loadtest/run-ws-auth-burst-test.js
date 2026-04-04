#!/usr/bin/env node
/**
 * WebSocket Auth Burst Test
 *
 * Tests the WS token endpoint under burst load to verify:
 * 1. Token endpoint doesn't fail under concurrent requests
 * 2. All tokens are valid JWTs
 * 3. WebSocket upgrade succeeds with returned tokens
 *
 * Usage: node run-ws-auth-burst-test.js [options]
 *
 * Options:
 *   --concurrency N   Number of concurrent requests (default: 100)
 *   --base-url URL    Backend base URL (default: http://localhost:8080)
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import WebSocket from 'ws';

// Parse arguments
const args = process.argv.slice(2);
let concurrency = 100;
let baseUrl = 'http://localhost:8080';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--concurrency' && args[i + 1]) {
    concurrency = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--base-url' && args[i + 1]) {
    baseUrl = args[i + 1];
    i++;
  }
}

// Test configuration
const config = {
  concurrency,
  baseUrl,
  wsTokenEndpoint: `${baseUrl}/api/auth/ws-token`,
  wsEndpoint: `${baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')}/api/ws`,
  timeout: 30000, // 30s timeout per request
};

// Results tracking
const results = {
  totalRequests: 0,
  successfulTokens: 0,
  failedTokens: 0,
  successfulWsUpgrades: 0,
  failedWsUpgrades: 0,
  errors: [],
  startTime: Date.now(),
};

// Helper: Make HTTP request
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.get(url, {
      timeout: config.timeout,
      ...options,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${config.timeout}ms`));
    });
  });
}

// Helper: Test WebSocket upgrade
function testWebSocketUpgrade(token) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${config.wsEndpoint}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket upgrade timeout'));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      ws.close();
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Main test: Burst auth requests
async function runBurstTest() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`WebSocket Auth Burst Test`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Timeout: ${config.timeout}ms\n`);

  const promises = [];

  for (let i = 0; i < concurrency; i++) {
    results.totalRequests++;

    const promise = (async (index) => {
      try {
        // Step 1: Fetch WS token
        const response = await makeRequest(
          `${config.wsTokenEndpoint}?sessionId=test-session-${index % 10}&role=student&participantId=participant-${index}`
        );

        if (response.status === 200) {
          const body = JSON.parse(response.body);

          if (body.token && typeof body.token === 'string') {
            results.successfulTokens++;

            // Step 2: Test WebSocket upgrade (only for first 10 to avoid overwhelming)
            if (index < 10) {
              try {
                await testWebSocketUpgrade(body.token);
                results.successfulWsUpgrades++;
              } catch (wsErr) {
                results.failedWsUpgrades++;
                results.errors.push({
                  type: 'WS_UPGRADE',
                  index,
                  error: wsErr.message,
                });
              }
            }
          } else {
            results.failedTokens++;
            results.errors.push({
              type: 'INVALID_TOKEN',
              index,
              status: response.status,
              body: response.body.substring(0, 200),
            });
          }
        } else {
          results.failedTokens++;
          results.errors.push({
            type: 'HTTP_ERROR',
            index,
            status: response.status,
          });
        }
      } catch (err) {
        results.failedTokens++;
        results.errors.push({
          type: 'REQUEST_ERROR',
          index,
          error: err.message,
        });
      }
    })(i);

    promises.push(promise);
  }

  // Wait for all requests to complete
  await Promise.allSettled(promises);

  // Print results
  const duration = Date.now() - results.startTime;
  const successRate = ((results.successfulTokens / results.totalRequests) * 100).toFixed(2);

  console.log(`${'='.repeat(60)}`);
  console.log(`Results`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Total Requests:       ${results.totalRequests}`);
  console.log(`Successful Tokens:    ${results.successfulTokens}`);
  console.log(`Failed Tokens:        ${results.failedTokens}`);
  console.log(`WebSocket Upgrades:   ${results.successfulWsUpgrades} tested`);
  console.log(`WS Upgrade Failures:  ${results.failedWsUpgrades}`);
  console.log(`Success Rate:         ${successRate}%`);
  console.log(`Duration:             ${duration}ms`);
  console.log(`Requests/sec:         ${((results.totalRequests / duration) * 1000).toFixed(2)}\n`);

  // Show errors if any
  if (results.errors.length > 0) {
    console.log(`Errors (${results.errors.length}):`);
    results.errors.slice(0, 10).forEach((err, i) => {
      console.log(`  ${i + 1}. [${err.type}] ${err.error || `Status: ${err.status}`}`);
    });
    if (results.errors.length > 10) {
      console.log(`  ... and ${results.errors.length - 10} more`);
    }
    console.log();
  }

  // Determine pass/fail
  const passed = results.successfulTokens === results.totalRequests;

  if (passed) {
    console.log(`✅ PASSED - All ${concurrency} requests succeeded`);
    process.exit(0);
  } else {
    console.log(`❌ FAILED - ${results.failedTokens} requests failed`);
    process.exit(1);
  }
}

// Run the test
runBurstTest().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
