// Simulate Hermes Agent request with many tools
const http = require('http');

// Generate realistic Hermes-like tools (simulating the 47 tools Hermes sends)
function makeTool(name, desc, params) {
  return {
    type: 'function',
    function: {
      name,
      description: desc,
      parameters: {
        type: 'object',
        properties: params,
        required: Object.keys(params).filter(k => params[k].required)
      }
    }
  };
}

function p(desc, type = 'string', required = false, extra = {}) {
  return { type, description: desc, required, ...extra };
}

const tools = [
  // Network tools
  makeTool('web_search', 'Search the web for information', {
    query: p('The search query', 'string', true),
    num_results: p('Number of results to return', 'integer')
  }),
  makeTool('web_extract', 'Extract content from a webpage URL', {
    url: p('The URL to extract content from', 'string', true),
    format: p('Output format: markdown or text', 'string', false, { enum: ['markdown', 'text'] })
  }),

  // Terminal & File tools
  makeTool('terminal', 'Execute a shell command in a sandboxed terminal environment', {
    command: p('The shell command to execute', 'string', true),
    cwd: p('Working directory for the command', 'string'),
    timeout: p('Timeout in milliseconds', 'integer'),
    env: p('Environment variables as JSON object', 'object')
  }),
  makeTool('read_file', 'Read the contents of a file from the filesystem', {
    path: p('Absolute path to the file to read', 'string', true),
    offset: p('Line number to start reading from', 'integer'),
    limit: p('Maximum number of lines to read', 'integer'),
    encoding: p('File encoding', 'string', false, { enum: ['utf-8', 'base64', 'latin1'] })
  }),
  makeTool('write_file', 'Write content to a file on the filesystem', {
    path: p('Absolute path where the file should be written', 'string', true),
    content: p('The content to write to the file', 'string', true),
    mode: p('Write mode: overwrite or append', 'string', false, { enum: ['overwrite', 'append'] })
  }),
  makeTool('patch', 'Apply a unified diff patch to a file', {
    path: p('Absolute path to the file to patch', 'string', true),
    patch: p('The unified diff patch content to apply', 'string', true)
  }),
  makeTool('glob', 'Find files matching a glob pattern', {
    pattern: p('Glob pattern to match files', 'string', true),
    path: p('Directory to search in', 'string')
  }),
  makeTool('grep', 'Search file contents using regex pattern', {
    pattern: p('Regular expression pattern to search for', 'string', true),
    path: p('File or directory to search in', 'string'),
    glob: p('Glob pattern to filter files', 'string'),
    output_mode: p('Output mode: content, files_with_matches, or count', 'string', false, { enum: ['content', 'files_with_matches', 'count'] })
  }),
  makeTool('list_files', 'List files and directories in a given path', {
    path: p('Absolute path to the directory to list', 'string', true),
    depth: p('Maximum recursion depth', 'integer'),
    ignore: p('Glob patterns to ignore', 'array')
  }),

  // Browser tools
  makeTool('browser_navigate', 'Navigate to a URL in a headless browser', {
    url: p('The URL to navigate to', 'string', true),
    wait_for: p('CSS selector or text to wait for before snapshot', 'string')
  }),
  makeTool('browser_snapshot', 'Take a text snapshot of the current browser page', {
    include_links: p('Whether to include link URLs in the snapshot', 'boolean')
  }),
  makeTool('browser_click', 'Click an element on the browser page', {
    selector: p('CSS selector or element description to click', 'string', true)
  }),
  makeTool('browser_type', 'Type text into an input element', {
    selector: p('CSS selector of the input element', 'string', true),
    text: p('Text to type into the input', 'string', true)
  }),
  makeTool('browser_screenshot', 'Take a screenshot of the current browser page', {
    full_page: p('Whether to capture the full page or just viewport', 'boolean')
  }),
  makeTool('browser_vision', 'Analyze the browser page visually using AI vision', {
    query: p('What to look for or analyze on the page', 'string', true)
  }),

  // Media tools
  makeTool('image_generate', 'Generate an image using AI from a text prompt', {
    prompt: p('Text description of the image to generate', 'string', true),
    size: p('Image dimensions', 'string', false, { enum: ['square', 'landscape', 'portrait'] }),
    style: p('Artistic style for the image', 'string')
  }),
  makeTool('text_to_speech', 'Convert text to speech audio', {
    text: p('The text to convert to speech', 'string', true),
    voice: p('Voice identifier to use', 'string'),
    speed: p('Speech speed multiplier', 'number')
  }),

  // Agent orchestration
  makeTool('todo', 'Manage a structured task list for tracking progress', {
    action: p('Action to perform: create, update, or complete', 'string', true, { enum: ['create', 'update', 'complete', 'list'] }),
    todos: p('Array of todo items', 'array'),
    merge: p('Whether to merge with existing todos', 'boolean')
  }),
  makeTool('delegate_task', 'Delegate a sub-task to a specialized sub-agent', {
    description: p('Short description of the task (3-5 words)', 'string', true),
    query: p('Detailed task description for the sub-agent', 'string', true),
    subagent_type: p('Type of specialized agent to use', 'string', true, { enum: ['search', 'general_purpose_task', 'browser_use'] })
  }),

  // Memory tools
  makeTool('memory_save', 'Save information to persistent memory', {
    key: p('Memory key or identifier', 'string', true),
    value: p('The information to store', 'string', true),
    category: p('Memory category for organization', 'string')
  }),
  makeTool('memory_search', 'Search through saved memories', {
    query: p('Search query to find relevant memories', 'string', true),
    category: p('Filter by memory category', 'string'),
    limit: p('Maximum number of results', 'integer')
  }),
  makeTool('session_search', 'Search through current and past conversation sessions', {
    query: p('Search query for session content', 'string', true),
    session_id: p('Specific session ID to search in', 'string')
  }),

  // Automation
  makeTool('cronjob', 'Schedule a recurring task with cron expression', {
    name: p('Name of the cron job', 'string', true),
    cron_expression: p('Standard 5-field cron expression', 'string', true),
    message: p('Task content to execute on schedule', 'string', true),
    timezone: p('IANA timezone string', 'string')
  }),
  makeTool('send_message', 'Send a message to a messaging platform', {
    platform: p('Target messaging platform', 'string', true, { enum: ['slack', 'discord', 'telegram', 'email'] }),
    recipient: p('Recipient identifier (channel, user ID, email)', 'string', true),
    message: p('The message content to send', 'string', true)
  }),

  // MCP Integration
  makeTool('mcp_list_tools', 'List available tools from an MCP server', {
    server_name: p('Name of the MCP server', 'string', true)
  }),
  makeTool('mcp_call_tool', 'Call a tool on an MCP server', {
    server_name: p('Name of the MCP server', 'string', true),
    tool_name: p('Name of the tool to call', 'string', true),
    args: p('Arguments to pass to the tool as JSON object', 'object', true)
  }),

  // Skill tools
  makeTool('skill_load', 'Load a skill by name to access its capabilities', {
    name: p('Name of the skill to load', 'string', true)
  }),
  makeTool('skill_list', 'List all available skills with descriptions', {}),

  // Conversation
  makeTool('ask_user', 'Ask the user a question when clarification is needed', {
    question: p('The question to ask the user', 'string', true),
    header: p('Short category label for the question', 'string'),
    options: p('Available choices for the user', 'array')
  }),
];

console.log(`Tools count: ${tools.length}`);
console.log(`Request body size (tools only): ${JSON.stringify(tools).length} chars`);

const body = JSON.stringify({
  model: 'qwen3.8-max-preview',
  messages: [
    { role: 'system', content: 'You are Hermes Agent, a helpful AI assistant by Nous Research.' },
    { role: 'user', content: 'Hello, say hi' }
  ],
  tools,
  stream: true,
  max_tokens: 50
});

console.log(`Total request body: ${body.length} chars`);

const options = {
  hostname: 'localhost',
  port: 9090,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-666666',
    'User-Agent': 'Hermes-Agent/0.19.0',
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
    console.log(`Total response bytes: ${allData.length}`);
    console.log(`Has [DONE]: ${allData.includes('[DONE]')}`);
    console.log(`\n=== Response ===`);
    console.log(allData.substring(0, 2000));
    if (allData.length > 2000) {
      console.log(`... (truncated, total ${allData.length} bytes)`);
    }
  });
});

req.on('error', (e) => console.error(`Error: ${e.message}`));
req.write(body);
req.end();