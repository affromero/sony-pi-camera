import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ProviderRegistry } from 'thesidedoor-core/ai';
import { modelSuggestions } from 'thesidedoor-core/ai/catalog';
import { cliInstalled, cliProviders } from './ai-cli.mjs';
import { apiProviders } from 'thesidedoor-core/ai/providers';
import { CredentialCodec, credentialStateSchema, initialCredentialState } from 'thesidedoor-core/configuration';
import { FileStateStore, localEncryptionKey } from 'thesidedoor-core/storage';

const providers = [...apiProviders().filter(({ descriptor }) =>
  descriptor.transport === 'api' && descriptor.capabilities.includes('vision') &&
  descriptor.capabilities.includes('structured')), ...cliProviders];
const sample = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAABwEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAIAAgAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgDf0oAAAAAB/9k=';
const descriptors = () => providers.map(({ descriptor }) => descriptor);

function selection(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.provider !== 'string' ||
      typeof value.model !== 'string' || typeof value.prompt !== 'string' ||
      value.model.length > 120 || value.prompt.length > 2000) return null;
  const { enabled, provider, model, prompt } = value;
  if (provider && !descriptors().some(({ id }) => id === provider)) return null;
  if (enabled && (!provider || !model.trim() || !prompt.trim())) return null;
  if (value.requireAdvice !== undefined && typeof value.requireAdvice !== 'boolean') return null;
  return { enabled, requireAdvice: value.requireAdvice ?? false, provider, model: model.trim(), prompt: prompt.trim() };
}

export function createAiConfig(directory, verify = verifyModel) {
  let proof;
  let testing = false;
  const store = new FileStateStore({
    path: join(directory, 'ai.json'),
    initial: () => ({ enabled: false, requireAdvice: false, provider: '', model: '', prompt: '', credentials: initialCredentialState() }),
    parse(value) {
      const config = selection(value);
      if (!config) throw new Error('Invalid saved AI settings');
      return { ...config, credentials: credentialStateSchema.parse(value.credentials) };
    },
  });
  const codec = (state, write = false) => new CredentialCodec({
    namespace: 'sony-pi-camera',
    descriptors,
    encryptionKey: () => localEncryptionKey(join(directory, 'provider.key'), {
      create: write && !state.credentials.providers.some(({ encrypted }) => encrypted),
    }),
  });
  function publicConfig({ enabled, requireAdvice, provider, model, prompt, credentials }) {
    return { enabled, requireAdvice, provider, model, prompt,
      providers: descriptors().map(({ id, label, transport, models }) => ({
        id, label, transport, models: [...new Map([
          ...modelSuggestions(id).map((model) => [model, { id: model, label: model }]),
          ...models.filter(({ capabilities }) => capabilities.includes('vision') && capabilities.includes('structured'))
            .map(({ id, label }) => [id, { id, label }]),
        ]).values()],
        hasKey: credentials.providers.some((item) => item.provider === id && item.encrypted),
      })),
      hasKey: credentials.providers.some((item) => item.provider === provider && item.encrypted) };
  }
  function draft(value) {
    const config = selection(value);
    if (!config || typeof value.apiKey !== 'string' || value.apiKey.length > 4096) return null;
    const adapter = providers.find(({ descriptor }) => descriptor.id === config.provider);
    const key = value.apiKey.trim();
    if (key && adapter?.descriptor.transport !== 'api') return null;
    return { config, adapter, key };
  }
  function candidate(state, { config, adapter, key }) {
    if (!adapter || !config.model) return null;
    const credentials = adapter.descriptor.transport === 'cli' ? {}
      : key ? { apiKey: key } : codec(state).resolveState(state.credentials, config.provider);
    if (adapter.descriptor.transport === 'api' && !credentials.apiKey) return null;
    return {
      fingerprint: createHash('sha256').update(JSON.stringify([config.provider, config.model, credentials.apiKey])).digest('hex'),
      registry: new ProviderRegistry({ providers: [adapter], credentials: { async resolve() { return credentials; } } }),
    };
  }
  return {
    async read() { return publicConfig(await store.read()); },
    async test(value) {
      const input = draft(value);
      if (!input?.adapter || !input.config.model) return { status: 'missing' };
      if (testing) return { status: 'busy' };
      testing = true;
      proof = undefined;
      try {
        if (input.adapter.descriptor.transport === 'cli' && !await cliInstalled(input.config.provider))
          return { status: 'not_installed' };
        const tested = candidate(await store.read(), input);
        if (!tested) return { status: 'missing' };
        await verify(input.config, tested.registry);
        proof = { fingerprint: tested.fingerprint, deadline: Date.now() + 5 * 60 * 1000 };
        return { status: 'valid' };
      } catch {
        return { status: 'failed' };
      } finally {
        testing = false;
      }
    },
    async update(value) {
      const input = draft(value);
      if (!input) return null;
      const { config, key } = input;
      return store.transact((state) => {
        const disabling = !config.enabled && !key && state.provider === config.provider && state.model === config.model;
        if (!disabling) {
          const tested = candidate(state, input);
          if (!tested || proof?.fingerprint !== tested.fingerprint || proof.deadline < Date.now()) return null;
        }
        if (key) codec(state, true).configureState(state.credentials, config.provider, { apiKey: key });
        Object.assign(state, config);
        return publicConfig(state);
      });
    },
    async selected() {
      const state = await store.read();
      if (!state.enabled) return null;
      const selected = candidate(state, draft({ ...state, apiKey: '' }));
      if (!selected) throw new Error('Missing AI provider configuration');
      return { config: state, registry: selected.registry };
    },
  };
}

async function verifyModel(config, registry) {
  const { requestAdvice } = await import('./advice.mjs');
  await requestAdvice({ jpeg: sample, settings: { mode: 'M' }, magnification: 1 }, {
    ...config, prompt: 'Describe the color of this sample image briefly. Return no setting suggestions.',
  }, registry);
}
