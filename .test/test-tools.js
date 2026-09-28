// Test with tools - simulate Hermes agent
const http = require('http');

const body = JSON.stringify({
  model: 'qwen3.8-max-preview',
  messages: [{ role: 'user', content: 'Say hello' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a bash command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to execute' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The file path' }
          },
          required: ['path']
        }
      }
    }
  ],
  stream: true,
  max_tokens: 50
});

console.log(`Body size: ${body.length} chars`);

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

const req = http.request(options, (res) => {
  console.log(`\nHTTP ${res.statusCode}`);
  let allData = '';
  
  res.on('data', (chunk) => {
    allData += chunk.toString();
  });
  
  res.on('end', () => {
    console.log(`Total bytes: ${allData.length}`);
    console.log(`Has [DONE]: ${allData.includes('[DONE]')}`);
    console.log(`\n=== Full response ===`);
    console.log(allData);
  });
});

req.on('error', (e) => console.error(`Error: ${e.message}`));
req.write(body);
req.end();