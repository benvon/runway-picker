import { registerResourceAdapters, type ResourceAdapterRegistry } from '../cache/registry';
import type { CacheResourceAdapter } from '../cache/types';
import { airportResourceAdapter } from './airport/adapter';
import { metarResourceAdapter } from './metar/adapter';

export const resourceAdapters: ReadonlyArray<CacheResourceAdapter<unknown, unknown, unknown>> = [
  metarResourceAdapter as CacheResourceAdapter<unknown, unknown, unknown>,
  airportResourceAdapter as CacheResourceAdapter<unknown, unknown, unknown>
];

export function createResourceRegistry(): ResourceAdapterRegistry {
  return registerResourceAdapters(resourceAdapters);
}
