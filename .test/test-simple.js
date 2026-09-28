// Simple test: just say hello, no tools
const http = require('http');

const body = JSON.stringify({
  model: 'qwen3.8-max-preview',
  messages: [
    { role: 'user', content: 'Hello, just say hi' }
  ],
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

console.log(`Request body: ${body.length} chars`);
console.log(`Model: qwen3.8-max-preview (no tools, no system prompt)`);

const req = http.request(options, (res) => {
  console.log(`\nHTTP ${res.statusCode}`);
  let allData = '';

  res.on('data', (chunk) => {
    allData += chunk.toString();
  });

  res.on('end', () => {
    console.log(`Total response: ${allData.length} bytes`);
    console.log(`Has [DONE]: ${allData.includes('[DONE]')}`);
    console.log(`\n=== Response ===`);
    console.log(allData.substring(0, 2000));
  });
});

req.on('error', (e) => console.error(`Error: ${e.message}`));
req.write(body);
req.end();