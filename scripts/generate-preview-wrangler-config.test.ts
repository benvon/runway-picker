import { describe, expect, it } from 'vitest';
import { buildPreviewWranglerConfigs, previewWorkerBaseName } from './generate-preview-wrangler-config.mjs';

describe('preview Wrangler config generation', () => {
  it('binds every PR preview to a distinct Worker service', () => {
    const generated = buildPreviewWranglerConfigs({
      workerConfig: { name: 'runway-picker-metar-api', env: { preview: { vars: { APP_ENV: 'preview' } } } },
      pagesConfig: { name: 'runway-picker', services: [{ binding: 'METAR_API', service: 'runway-picker-metar-api' }] },
      workerName: 'runway-picker-metar-api',
      pullRequestNumber: '89',
      cacheNamespaceId: 'preview-cache-id'
    });

    expect(generated.workerConfig).toMatchObject({
      name: 'runway-picker-metar-api-pr-89',
      env: {
        preview: {
          vars: { APP_ENV: 'preview' },
          kv_namespaces: [{ binding: 'METAR_CACHE', id: 'preview-cache-id' }]
        }
      }
    });
    expect(generated.pagesConfig).toMatchObject({
      env: {
        preview: {
          services: [{ binding: 'METAR_API', service: 'runway-picker-metar-api-pr-89-preview' }]
        }
      }
    });
  });

  it('rejects invalid PR numbers and Worker names that cannot form a valid preview service', () => {
    expect(() => previewWorkerBaseName('runway-picker-metar-api', '0')).toThrow('positive integer');
    expect(() => previewWorkerBaseName('a'.repeat(60), '89')).toThrow('63-character limit');
  });
});
