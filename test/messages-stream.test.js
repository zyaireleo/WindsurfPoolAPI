import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadTransform() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'windsurf-messages-test-'));
  const handlersDir = join(tempRoot, 'handlers');
  await mkdir(handlersDir, { recursive: true });

  const srcPath = '/Users/zyaire/Documents/API Router/WindsurfPoolAPI/src/handlers/messages.js';
  const original = await readFile(srcPath, 'utf8');
  const patched = original.replace(
    'class AnthropicStreamTransform {',
    'export class AnthropicStreamTransform {',
  );

  await writeFile(join(handlersDir, 'messages.js'), patched);
  await writeFile(join(handlersDir, 'chat.js'), 'export async function handleChatCompletions() { throw new Error("not used in test"); }\n');
  await writeFile(join(tempRoot, 'models.js'), 'export function resolveModel(name) { return name; }\n');
  await writeFile(
    join(tempRoot, 'config.js'),
    'export const config = { defaultModel: "claude-sonnet-4.6" };\nexport const log = { debug() {}, info() {}, warn() {}, error() {} };\n',
  );

  return import(pathToFileURL(join(handlersDir, 'messages.js')).href);
}

function createCaptureRes() {
  return {
    writableEnded: false,
    chunks: [],
    on() {},
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
    },
  };
}

function extractEvents(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .map(frame => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      const eventLine = lines.find(line => line.startsWith('event: '));
      const dataLine = lines.find(line => line.startsWith('data: '));
      if (!eventLine || !dataLine) return null;
      return {
        event: eventLine.slice(7),
        data: JSON.parse(dataLine.slice(6)),
      };
    })
    .filter(Boolean);
}

test('closes a tool block before starting a later text block', async () => {
  const { AnthropicStreamTransform } = await loadTransform();
  const res = createCaptureRes();
  const transform = new AnthropicStreamTransform(res, 'claude-sonnet-4.6');

  transform.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
  transform.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n');
  transform.write('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n');
  transform.write('data: [DONE]\n\n');

  const events = extractEvents(res.chunks);
  const eventTypes = events.map(e => `${e.event}:${e.data.index ?? ''}`);

  const toolStart = eventTypes.indexOf('content_block_start:0');
  const toolStop = eventTypes.indexOf('content_block_stop:0');
  const textStart = eventTypes.indexOf('content_block_start:1');

  assert.notEqual(toolStart, -1, 'expected tool block start');
  assert.notEqual(toolStop, -1, 'expected tool block stop');
  assert.notEqual(textStart, -1, 'expected text block start');
  assert.ok(toolStop < textStart, 'tool block must stop before the later text block starts');
});

test('closes an earlier tool block before starting another tool block', async () => {
  const { AnthropicStreamTransform } = await loadTransform();
  const res = createCaptureRes();
  const transform = new AnthropicStreamTransform(res, 'claude-sonnet-4.6');

  transform.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
  transform.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"Glob","arguments":"{\\"pattern\\":\\"src/**/*.js\\"}"}}]},"finish_reason":null}]}\n\n');
  transform.write('data: [DONE]\n\n');

  const events = extractEvents(res.chunks);
  const eventTypes = events.map(e => `${e.event}:${e.data.index ?? ''}`);

  const firstToolStart = eventTypes.indexOf('content_block_start:0');
  const firstToolStop = eventTypes.indexOf('content_block_stop:0');
  const secondToolStart = eventTypes.indexOf('content_block_start:1');

  assert.notEqual(firstToolStart, -1, 'expected first tool block start');
  assert.notEqual(firstToolStop, -1, 'expected first tool block stop');
  assert.notEqual(secondToolStart, -1, 'expected second tool block start');
  assert.ok(firstToolStop < secondToolStart, 'first tool block must stop before the next tool block starts');
});
