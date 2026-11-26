import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { modelSuggestions } from 'thesidedoor-core/ai/catalog';
import { ProcessRunner } from 'thesidedoor-core/runtime/process';

const runner = new ProcessRunner(1);
const executable = (id) => id === 'claude-code' ? 'claude' : 'codex';

export async function cliInstalled(id) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, executable(id)), constants.X_OK);
      return true;
    } catch { /* Check the next directory. */ }
  }
  return false;
}

async function invoke(id, request, signal) {
  const cwd = await mkdtemp(join(tmpdir(), 'sony-ai-'));
  const parts = request.messages.flatMap(({ content }) => content);
  const image = parts.find(({ type }) => type === 'image');
  const prompt = parts.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n\n');
  const environment = { HOME: homedir(), PATH: process.env.PATH, LANG: 'C.UTF-8' };
  try {
    if (id === 'claude-code') {
      const content = [{ type: 'text', text: prompt }];
      if (image) content.push({ type: 'image', source: {
        type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64'),
      } });
      const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
      const { stdout } = await runner.execute({ command: 'claude', cwd, environment, input, signal, maxOutputBytes: 65536,
        args: ['-p', '--safe-mode', '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config',
          '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--permission-mode', 'dontAsk', '--verbose',
          '--model', request.model, '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--json-schema', JSON.stringify(request.schema)],
      });
      const result = stdout.trim().split('\n').map((line) => JSON.parse(line)).findLast(({ type }) => type === 'result');
      if (!result || result.is_error || !result.structured_output) throw new Error('Claude Code returned no structured output.');
      return JSON.stringify(result.structured_output);
    }
    const schema = join(cwd, 'schema.json');
    const output = join(cwd, 'answer.json');
    await writeFile(schema, JSON.stringify(request.schema), { mode: 0o600 });
    const args = ['--ask-for-approval', 'never', '--disable', 'shell_tool', '--disable', 'unified_exec',
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'web_search="disabled"',
      '--output-schema', schema, '--output-last-message', output];
    if (request.model !== 'codex') args.push('--model', request.model);
    if (image) {
      const path = join(cwd, 'preview.jpg');
      await writeFile(path, image.data, { mode: 0o600 });
      args.push('--image', path);
    }
    await runner.execute({ command: 'codex', cwd, environment, input: prompt, signal,
      args: [...args, '-'], maxOutputBytes: 65536 });
    return await readFile(output, 'utf8');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export const cliProviders = [
  ['claude-code', 'Claude Code CLI'],
  ['codex', 'Codex CLI'],
].map(([id, label]) => {
  const capabilities = ['text', 'vision', 'structured'];
  const models = modelSuggestions(id).map((model) => ({
    id: model, label: model === 'codex' ? 'Default Codex model' : model, capabilities,
  }));
  return {
    descriptor: { id, label, transport: 'cli', fields: [], capabilities, models },
    async models() { return models; },
    async readiness() { return { code: 'not_configured', checkedAt: Date.now() }; },
    async *generate(request, { signal }) {
      yield { type: 'text', text: await invoke(id, request, signal) };
      yield { type: 'finish', reason: 'complete' };
    },
  };
});
