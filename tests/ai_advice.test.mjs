import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAdvice } from '../camera/sidedoor/advice.mjs';

const config = { provider: 'openai', model: 'example', prompt: 'Brighten dawn without motion blur' };
const snapshot = {
  jpeg: '/9j/2Q==',
  magnification: 1,
  settings: {
    mode: 'A',
    iso: { current: '100', choices: ['100', '400'], readonly: false },
    shutterspeed: { current: '1/250', choices: ['1/125'], readonly: true },
  },
};

test('analyzes the supplied frame against the goal and returns a writable choice', async () => {
  const registry = {
    async *generate(request) {
      const [{ text }, image] = request.messages.find(({ role }) => role === 'user').content;
      assert.equal(JSON.parse(text).goal, config.prompt);
      assert.equal(image.mediaType, 'image/jpeg');
      assert.deepEqual(image.data, Buffer.from(snapshot.jpeg, 'base64'));
      yield { type: 'text', text: '{"assessment":"Dark shadows","suggestions":[' };
      yield { type: 'text', text: '{"setting":"iso","value":"400","reason":"Hold shutter speed"}]}' };
    },
  };
  assert.deepEqual(await requestAdvice(snapshot, config, registry), {
    assessment: 'Dark shadows',
    suggestions: [{ setting: 'iso', current: '100', suggested: '400', reason: 'Hold shutter speed' }],
  });
});

test('rejects unsupported, readonly, unchanged and duplicate suggestions', async () => {
  for (const [setting, value, count] of [
    ['aperture', 'f/4', 1], ['iso', '1234', 1], ['iso', '100', 1], ['iso', '400', 2],
    ['shutterspeed', '1/125', 1],
  ]) {
    const registry = {
      async *generate() {
        const suggestions = Array.from({ length: count }, () => ({ setting, value, reason: 'Test' }));
        yield { type: 'text', text: JSON.stringify({ assessment: 'Dark', suggestions }) };
      },
    };
    await assert.rejects(requestAdvice(snapshot, config, registry), /invalid advice/);
  }
});

test('accepts a preview that needs no changes', async () => {
  const registry = {
    async *generate() {
      yield { type: 'text', text: '{"assessment":"The sky looks right","suggestions":[]}' };
    },
  };
  assert.deepEqual(await requestAdvice(snapshot, config, registry),
    { assessment: 'The sky looks right', suggestions: [] });
});

test('does not leak provider credentials or errors into the timer log', async () => {
  const registry = {
    async *generate() {
      throw new Error('Request includes test-secret');
    },
  };
  await assert.rejects(requestAdvice(snapshot, config, registry), (error) =>
    /provider request failed/.test(error.message) && !error.message.includes('test-secret'));
});
