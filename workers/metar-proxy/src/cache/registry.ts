import type { CacheResourceAdapter } from './types';

export type ResourceAdapterRegistry = Map<string, CacheResourceAdapter<unknown, unknown, unknown>>;

function assertAdapterShape(adapter: CacheResourceAdapter<unknown, unknown, unknown>): void {
  if (!adapter.resource || typeof adapter.resource !== 'string') {
    throw new Error('Cache adapter missing resource id.');
  }

  const requiredFunctions = [
    adapter.normalizeKey,
    adapter.fetchUpstream,
    adapter.validate,
    adapter.serialize,
    adapter.deserialize,
    adapter.observability
  ];

  if (requiredFunctions.some((fn) => typeof fn !== 'function')) {
    throw new Error(`Cache adapter ${adapter.resource} is missing required methods.`);
  }
}

export function registerResourceAdapters(
  adapters: ReadonlyArray<CacheResourceAdapter<unknown, unknown, unknown>>
): ResourceAdapterRegistry {
  const registry: ResourceAdapterRegistry = new Map();

  for (const adapter of adapters) {
    assertAdapterShape(adapter);

    if (registry.has(adapter.resource)) {
      throw new Error(`Duplicate cache adapter registration for resource ${adapter.resource}.`);
    }

    registry.set(adapter.resource, adapter);
  }

  return registry;
}

export function getAdapterOrThrow(
  registry: ResourceAdapterRegistry,
  resource: string
): CacheResourceAdapter<unknown, unknown, unknown> {
  const adapter = registry.get(resource);
  if (!adapter) {
    throw new Error(`No cache adapter registered for resource ${resource}.`);
  }

  return adapter;
}
