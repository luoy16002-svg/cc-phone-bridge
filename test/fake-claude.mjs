// Stands in for `claude -p --input-format stream-json --output-format stream-json` in tests: the same event shapes,
// and like the real one it writes the conversation to CLAUDE_CONFIG_DIR/projects/<folder key>/<session id>.jsonl.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const resume = at('--resume');
const forking = !!resume && args.includes('--fork-session');
const model = at('--model') || 'claude-opus-5-5';
const session = resume && !forking ? resume : crypto.randomUUID();
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${session}.jsonl`);
let parent = null;
// a branch starts as a copy of the old session, up to and including the entry --resume-session-at names
if (forking) {
  const cut = at('--resume-session-at');
  for (const l of fs.readFileSync(path.join(dir, `${resume}.jsonl`), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const o = JSON.parse(l);
    if (o.sessionId) o.sessionId = session;
    fs.appendFileSync(file, `${JSON.stringify(o)}\n`);
    if (o.uuid) parent = o.uuid;
    if (cut && o.uuid === cut) break;
  }
}
if (at('--name') && !(resume && !forking)) fs.appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: at('--name'), sessionId: session })}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: session })}\n`);
const save = (o) => {
  const line = { parentUuid: parent, isSidechain: false, cwd: process.cwd(), sessionId: session, timestamp: new Date().toISOString(), ...o };
  if (o.uuid) parent = o.uuid;
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let interrupted = null;
let busy = Promise.resolve();

function textOf(content) {
  return (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function assistant(content) {
  const uuid = crypto.randomUUID();
  const message = { role: 'assistant', model, content };
  save({ type: 'assistant', uuid, message });
  out({ type: 'assistant', uuid, message, parent_tool_use_id: null });
}

function toolResult(id, text, isError = false) {
  const uuid = crypto.randomUUID();
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] };
  save({ type: 'user', uuid, message });
  out({ type: 'user', uuid, message, parent_tool_use_id: null });
}

async function streamText(text) {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const part of [text.slice(0, 3), text.slice(3, 8), text.slice(8)]) {
    if (!part) continue;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
    await sleep(15);
  }
  assistant([{ type: 'text', text }]);
}

async function turn(msg) {
  const t0 = Date.now();
  const text = textOf(msg.message.content);
  const images = msg.message.content.filter((c) => c.type === 'image').length;
  // what the conversation holds before this message, so a branch can show what it kept
  const earlier = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((o) => o.type === 'user' && Array.isArray(o.message?.content) && o.message.content[0]?.type === 'text').map((o) => o.message.content[0].text) : [];
  out({ type: 'system', subtype: 'init', model, cwd: process.cwd(), tools: [] });
  save({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: msg.message.content.map((c) => (c.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } } : c)) } });
  fs.appendFileSync(file, `${JSON.stringify({ type: 'last-prompt', lastPrompt: text, sessionId: session })}\n`);
  if (/crash/.test(text)) {
    process.stderr.write('boom: fake crash\n');
    process.exit(2);
  }
  if (/slow/.test(text)) {
    assistant([{ type: 'tool_use', id: 'tool-slow', name: 'Bash', input: { command: 'ping -n 60 127.0.0.1', description: process.env.FAKE_LANG === "en" ? "Run the slow test suite" : "跑一遍慢测试" } }]);
    interrupted = null;
    for (let i = 0; i < 300 && !interrupted; i++) await sleep(100);
    if (interrupted) {
      out({ type: 'control_response', response: { subtype: 'success', request_id: interrupted, response: { still_queued: [] } } });
      toolResult('tool-slow', 'The user doesn\'t want to proceed with this tool use.', true);
      const uuid = crypto.randomUUID();
      const message = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] };
      save({ type: 'user', uuid, message });
      out({ type: 'user', uuid, message, parent_tool_use_id: null });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: Date.now() - t0, num_turns: 1, terminal_reason: 'aborted_tools', total_cost_usd: 0 });
      return;
    }
  }
  if (/tool/.test(text)) {
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read' } } });
    assistant([{ type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } }]);
    toolResult('tool-read', [{ type: 'text', text: 'line one\nline two' }]);
  }
  if (/前面说过什么/.test(text)) await streamText(`说过：${earlier.join('｜') || '没有'}`);
  else await streamText(images ? `got ${images} image` : `${process.env.FAKE_LANG === "en" ? "Got it: " : "收到："}${text}${args.includes('--effort') ? ` (${at('--effort')})` : ''}`);
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, num_turns: 1, result: 'ok', terminal_reason: 'completed', total_cost_usd: 0.001 });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    interrupted = msg.request_id;
    return;
  }
  if (msg.type === 'user') busy = busy.then(() => turn(msg));
});
rl.on('close', () => busy.then(() => process.exit(0)));
