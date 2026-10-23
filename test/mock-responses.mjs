// A stand-in for the model API that real Codex talks to (the Responses API, streamed): it answers every request
// with "收到：<the last thing the user said>", followed by " · 之前：..." listing what the user said before, so a test
// can see which history a thread or a branch carried. A message containing SLOW is answered after a pause.
import http from 'node:http';

export function startMockModel({ charMs = 40, slowMs = 2500 } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      calls++;
      const said = [];
      try {
        for (const item of JSON.parse(body).input || []) {
          if (item.role !== 'user' || !Array.isArray(item.content)) continue;
          const t = item.content.filter((c) => c.type === 'input_text').map((c) => c.text).join('').trim();
          if (t && !/^[<#]/.test(t)) said.push(t);
        }
      } catch { /* not JSON */ }
      const last = said.pop() || '';
      const reply = `收到：${last}${said.length ? ` · 之前：${said.join(' | ')}` : ''}`;
      const id = `resp_${calls}`;
      const msg = `msg_${calls}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      send({ type: 'response.created', response: { id } });
      send({ type: 'response.output_item.added', item: { type: 'message', role: 'assistant', id: msg, content: [{ type: 'output_text', text: '' }] } });
      if (last.includes('SLOW')) await wait(slowMs);
      for (const ch of Array.from(reply)) {
        send({ type: 'response.output_text.delta', delta: ch });
        await wait(charMs);
      }
      send({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: msg, content: [{ type: 'output_text', text: reply }] } });
      send({ type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls: () => calls })));
}

// A CODEX_HOME config that points Codex at the stand-in, with no account needed.
export function mockConfig(port) {
  return `model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"
model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`;
}
