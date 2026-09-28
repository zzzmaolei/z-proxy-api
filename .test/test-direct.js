// Test script: send a simple request to proxy and observe full flow
const http = require('http');

const body = JSON.stringify({
  model: 'qwen3.8-max-preview',
  messages: [{ role: 'user', content: 'Say hello' }],
  stream: true,
  max_tokens: 50
});

const options = {
  hostname: 'localhost',
  port: 9090,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-666666',
    'Content-Length': Buffer.byteLength(body)
  }
};

console.log('=== Sending request ===');
console.log(`Body size: ${body.length} chars`);

const req = http.request(options, (res) => {
  console.log(`\n=== Response ===`);
  console.log(`HTTP ${res.statusCode}`);
  console.log(`Headers: ${JSON.stringify(res.headers)}`);
  
  let totalChunks = 0;
  let totalBytes = 0;
  let allData = '';
  
  res.on('data', (chunk) => {
    totalChunks++;
    totalBytes += chunk.length;
    const text = chunk.toString();
    allData += text;
    // Print first few chunks
    if (totalChunks <= 5) {
      console.log(`\n[Chunk ${totalChunks}] (${chunk.length}B): ${text.slice(0, 300)}`);
    }
  });
  
  res.on('end', () => {
    console.log(`\n=== Stream ended ===`);
    console.log(`Total chunks: ${totalChunks}`);
    console.log(`Total bytes: ${totalBytes}`);
    console.log(`Has [DONE]: ${allData.includes('[DONE]')}`);
    console.log(`\n=== Last 500 chars ===`);
    console.log(allData.slice(-500));
  });
});

req.on('error', (e) => {
  console.error(`Request error: ${e.message}`);
});

req.write(body);
req.end();