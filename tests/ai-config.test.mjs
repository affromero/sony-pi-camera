import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAiConfig } from '../camera/sidedoor/ai-config.mjs';

test('only saves the tested provider, model and key and preserves settings on failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sony-ai-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let passing = true;
  const ai = createAiConfig(directory, async ({ model }) => {
    assert.equal(model, 'vision-model');
    if (!passing) throw new Error('Provider rejected the draft.');
  });
  const input = { enabled: true, provider: 'openai', model: 'vision-model', apiKey: 'test-key', prompt: 'Lift shadows' };
  const file = join(directory, 'ai.json');
  assert.ok((await ai.read()).providers.some(({ id, transport }) => id === 'codex' && transport === 'cli'));
  assert.equal(await ai.update(input), null);
  assert.equal((await ai.test(input)).status, 'valid');
  assert.equal(await ai.update({ ...input, apiKey: 'untested-key' }), null);
  assert.equal(await ai.update({ ...input, model: 'untested-model' }), null);
  assert.equal((await ai.update(input)).hasKey, true);
  const before = await readFile(file, 'utf8');
  assert.ok(!before.includes('test-key'));
  passing = false;
  const replacement = { ...input, apiKey: 'rejected-key' };
  assert.equal((await ai.test(replacement)).status, 'failed');
  assert.equal(await ai.update(replacement), null);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await ai.update({ ...input, enabled: false, apiKey: '' })).enabled, false);
});
