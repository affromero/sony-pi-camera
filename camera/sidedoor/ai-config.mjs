import { join } from 'node:path';
import { ProviderRegistry } from 'thesidedoor-core/ai';
import { apiProviders } from 'thesidedoor-core/ai/providers';
import { CredentialCodec, credentialStateSchema, initialCredentialState } from 'thesidedoor-core/configuration';
import { FileStateStore, localEncryptionKey } from 'thesidedoor-core/storage';

const providers = apiProviders().filter(({ descriptor }) =>
  descriptor.transport === 'api' && descriptor.capabilities.includes('vision') &&
  descriptor.capabilities.includes('structured'));
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

export function createAiConfig(directory) {
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
    return { enabled, requireAdvice, provider, model, prompt, providers: descriptors().map(({ id, label }) => ({ id, label })),
      hasKey: credentials.providers.some((item) => item.provider === provider && item.encrypted) };
  }
  function registryFor(state) {
    const credentials = codec(state).resolveState(state.credentials, state.provider);
    if (!credentials.apiKey) return null;
    return new ProviderRegistry({
      providers: providers.filter(({ descriptor }) => descriptor.id === state.provider),
      credentials: { async resolve() { return credentials; } },
    });
  }
  return {
    async read() { return publicConfig(await store.read()); },
    async update(value) {
      const config = selection(value);
      const key = value?.apiKey;
      if (!config || typeof key !== 'string' || key.length > 4096 || (key && !config.provider)) return null;
      return store.transact((state) => {
        const credentials = codec(state, true);
        if (key.trim()) credentials.configureState(state.credentials, config.provider, { apiKey: key.trim() });
        if (config.enabled && !credentials.resolveState(state.credentials, config.provider).apiKey) return null;
        Object.assign(state, config);
        return publicConfig(state);
      });
    },
    async check() {
      const state = await store.read();
      const registry = state.provider && registryFor(state);
      if (!registry) return { status: 'missing' };
      const { status } = await registry.validateCredentials(state.provider);
      return { status };
    },
    async selected() {
      const state = await store.read();
      if (!state.enabled) return null;
      const registry = registryFor(state);
      if (!registry) throw new Error('Missing AI credential');
      return { config: state, registry };
    },
  };
}
