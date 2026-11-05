import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFiles } from '../../src/generate.ts';
import { runDoctor } from '../../src/doctor/analyze.ts';
import { renderForm, renderStart } from '../../src/render/order-html.ts';

describe('generated contracts and rendered native forms', () => {
  it('checks real renderer output against fresh root-relative contract projections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'typehtml-render-doctor-'));
    try {
      const contractPath = join(directory, 'order.boundary.json');
      await writeFile(contractPath, await readFile(resolve(import.meta.dir, '../../docs/design/v0.5/examples/order.boundary.json')));
      await generateFiles({ contractPath, outDir: join(directory, 'generated'), rootDir: directory });
      const view = { productId: 'p_100', productName: 'Example', unitPriceMinor: 12000, currency: 'KRW' as const, productRevision: 7 };
      await writeFile(join(directory, 'start.html'), renderStart(view, 'synthetic-csrf', '/actions/orders/begin-draft'));
      await writeFile(join(directory, 'form.html'), renderForm(view, {
        rawValues: { quantity: '21' }, fieldErrors: { quantity: ['MAXIMUM'] }, formErrors: [],
        csrfToken: 'synthetic-csrf', intentId: 'synthetic-intent',
      }, '/actions/orders/create-draft', { minQuantity: 1, maxQuantity: 20, productIdMaxLength: 64 }));
      const configPath = join(directory, 'doctor.config.json');
      await writeFile(configPath, JSON.stringify({
        format: 'boundary-doctor/0.5-draft', root: directory,
        inputs: ['form-check.generated.json', 'start-form-check.generated.json'].map((name) => ({ kind: 'form-projection', path: `generated/${name}` })),
        documents: [
          { path: 'start.html', documentUrl: 'http://localhost/orders/new?productId=p_100', formId: 'begin-draft', actionId: 'orders.createDraft.begin' },
          { path: 'form.html', documentUrl: 'http://localhost/orders/new?intent=synthetic-intent', formId: 'create-draft', actionId: 'orders.createDraft' },
        ].map(({ formId, actionId, ...document }) => ({ ...document, sourceKind: 'rendered-snapshot', executionAssumption: 'native-no-script-by-example',
          bindings: [{ formId, actionId, required: true, submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' }],
        })),
      }));
      const report = await runDoctor(configPath);
      expect(report.error).toBeUndefined();
      expect(report.exitCode).toBe(0);
      expect(report.scope.paths).toBe(2);
      expect(report.findings).toEqual([]);
      expect(report.submissions.every((submission) => submission.projectionSource.path === 'order.boundary.json')).toBe(true);
      expect(JSON.stringify(report)).not.toContain('synthetic-csrf');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
