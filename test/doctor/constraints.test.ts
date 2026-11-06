import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { IntegerFieldSchema } from '../../src/contract/types.ts';
import {
  acceptsNativeInteger, alignsWithNativeStep, nativeIntegerLimits, parseNativeNumber,
  readNativeIntegerConstraints, selectNativeIntegerControl,
} from '../../src/doctor/constraints.ts';
import { runDoctor } from '../../src/doctor/analyze.ts';
import { parseHtmlDocument } from '../../src/doctor/html.ts';
import { defineForm } from '../../src/form/definition.ts';
import { loadForm, projectForm } from '../../src/form/manifest.ts';

const schema: IntegerFieldSchema = Object.freeze({ type: 'integer', minimum: 2, maximum: 10 });
const directories: { path: string; parent: string }[] = [];

function control(attributes: string) {
  return parseHtmlDocument(`<form><input name="quantity" ${attributes}></form>`, 'https://example.invalid/form').controls[0]!;
}

function constraints(attributes: string) {
  return readNativeIntegerConstraints(selectNativeIntegerControl(schema, control(attributes), false)!);
}

function observeAttributes(input: ReturnType<typeof control>, reads: string[]) {
  for (const item of input.element.attrs) {
    const value = item.value;
    Object.defineProperty(item, 'value', { get: () => { reads.push(item.name); return value; } });
    Object.freeze(item);
  }
  Object.freeze(input.element.attrs);
  Object.freeze(input);
}

async function fixture(body: string, extraField = false) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'typehtml-constraints-'));
  directories.push({ path: directory, parent });
  const form = defineForm({
    id: 'quantity.submit', path: '/submit',
    input: { type: 'object', additionalProperties: false, required: ['quantity'], properties: {
      quantity: schema, ...(extraField ? { note: { type: 'string' as const } } : {}),
    } },
    output: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
  });
  await writeFile(join(directory, 'form.json'), JSON.stringify(form.definition));
  const loaded = await loadForm(join(directory, 'form.json'));
  const projection = projectForm(loaded.form, { sourcePath: 'form.json', sourceSha256: loaded.sourceSha256 });
  const html = `<form id="f" method="post" action="/submit">${body}<input type="hidden" name="_bc_csrf"><button>Send</button></form>`;
  const config = {
    format: 'boundary-doctor/0.5-draft', root: directory,
    inputs: [{ kind: 'form-projection', path: 'check.json' }],
    documents: [{ path: 'form.html', documentUrl: 'https://example.invalid/form', sourceKind: 'rendered-snapshot',
      executionAssumption: 'native-no-script-by-example', bindings: [{ formId: 'f', actionId: form.id, required: true,
        submitterPolicy: 'enumerate-native', constraintMismatchSeverity: 'warning' }] }],
  };
  await Promise.all([
    writeFile(join(directory, 'check.json'), JSON.stringify(projection)),
    writeFile(join(directory, 'form.html'), html),
    writeFile(join(directory, 'doctor.json'), JSON.stringify(config)),
  ]);
  return { directory, configPath: join(directory, 'doctor.json'), html, projection };
}

afterEach(async () => {
  for (const { path, parent } of directories.splice(0)) {
    const actual = await realpath(path);
    if (resolve(actual) !== resolve(path) || dirname(actual) !== parent || !basename(actual).startsWith('typehtml-constraints-')) {
      throw new Error('refusing cleanup outside constraint fixture');
    }
    await rm(actual, { recursive: true, force: true });
  }
});

describe('native integer constraint calculations', () => {
  test('preserves exact numeric syntax, finite bounds and default/any step policy', () => {
    for (const raw of [null, '', ' ', ' 1', '1 ', '+1', '1.', 'Infinity', '1e9999']) expect(parseNativeNumber(raw)).toBeNull();
    for (const [raw, expected] of [['1', 1], ['-1', -1], ['.5', 0.5], ['1e2', 100], ['-0', -0]] as const) {
      expect(parseNativeNumber(raw)).toBe(expected);
    }
    const offset = constraints('type="number" value="1" step="2"');
    expect([acceptsNativeInteger(3, offset), acceptsNativeInteger(2, offset)]).toEqual([true, false]);
    for (const step of ['', '0', '-2', 'nonsense']) expect(constraints(`type="number" step="${step}"`).step).toBe(1);
    expect(constraints('type="number" step="AnY"').step).toBeNull();
    const decimal = constraints('type="number" min="0.2" max="2" step="0.2" value="99"');
    expect(decimal.base).toBe(0.2);
    expect([acceptsNativeInteger(1, decimal), acceptsNativeInteger(3, decimal)]).toEqual([true, false]);
    expect(alignsWithNativeStep(1, 0.0000000005, 1)).toBe(true);
    expect(alignsWithNativeStep(1, 0.000000002, 1)).toBe(false);
  });

  test('keeps attribute reads ordered and skips excluded controls without reading attributes', () => {
    const input = control('type="number" min="bad" max="20" step="2" value="1" pattern="ignored"');
    const reads: string[] = [];
    observeAttributes(input, reads);
    expect(selectNativeIntegerControl(schema, input, true)).toBeNull();
    expect(selectNativeIntegerControl(schema, { ...input, readonly: true }, false)).toBeNull();
    expect(reads).toEqual([]);
    const native = selectNativeIntegerControl(schema, input, false)!;
    const actual = readNativeIntegerConstraints(native);
    expect(reads).toEqual(['pattern', 'min', 'max', 'step', 'step', 'value']);
    expect(actual).toMatchObject({ htmlMin: null, htmlMax: 20, step: 2, base: 1 });
    expect(Object.isFrozen(input)).toBe(true);
    expect(schema).toEqual({ type: 'integer', minimum: 2, maximum: 10 });
  });

  test('recognizes only the exact text pattern and lazily reads text lengths for each safe candidate', () => {
    const input = control('type="text" pattern="([1-9]|1[0-9]|20)" min="100" max="0" minlength="2" maxlength="2"');
    const reads: string[] = [];
    observeAttributes(input, reads);
    const actual = readNativeIntegerConstraints(selectNativeIntegerControl(schema, input, false)!);
    expect(reads).toEqual(['pattern']);
    expect(acceptsNativeInteger(Number.MAX_SAFE_INTEGER + 1, actual)).toBe(false);
    expect(reads).toEqual(['pattern']);
    expect([acceptsNativeInteger(11, actual), acceptsNativeInteger(1, actual), acceptsNativeInteger(21, actual)]).toEqual([true, false, false]);
    expect(reads.slice(1)).toEqual(['minlength', 'maxlength', 'minlength', 'maxlength', 'minlength', 'maxlength']);
    expect(selectNativeIntegerControl(schema, control('type="text" pattern="^([1-9]|1[0-9]|20)$"'), false)).toBeNull();
  });

  test('keeps maximum before minimum and rejects unsafe generated candidates', () => {
    const native = constraints('type="number" step="any"');
    expect(nativeIntegerLimits(schema, native).map(({ kind, candidate }) => [kind, candidate])).toEqual([['max', 11], ['min', 1]]);
    const extreme = Object.freeze({ type: 'integer' as const, maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER });
    expect(nativeIntegerLimits(extreme, native).map(({ candidate }) => acceptsNativeInteger(candidate!, native))).toEqual([false, false]);
  });
});

describe('constraint witness effects', () => {
  test('preserves maximum/minimum witness order, payload and incomplete coverage note without changing files', async () => {
    const item = await fixture('<input type="number" name="quantity" min="0" max="20" step="any"><input name="note">', true);
    const report = await runDoctor(item.configPath);
    const witnesses = report.findings.filter((finding) => finding.ruleId === 'BC013');
    expect(witnesses.map(({ subcode }) => subcode)).toEqual(['max-witness', 'min-witness']);
    expect(witnesses.map(({ witness }) => witness)).toEqual([
      { rawValue: '11', codecValue: 11, codec: 'decimal-integer', schemaPointer: '/input/schema/properties/quantity/maximum',
        source: item.projection.source, synthetic: true, nativeValidation: 'enabled-for-selected-activation', hypotheticalServerMaximum: 10, unchangedHtmlMaximum: 20 },
      { rawValue: '1', codecValue: 1, codec: 'decimal-integer', schemaPointer: '/input/schema/properties/quantity/minimum',
        source: item.projection.source, synthetic: true, nativeValidation: 'enabled-for-selected-activation', hypotheticalServerMinimum: 2 },
    ]);
    expect(report.coverage.find(({ ruleGroup }) => ruleGroup === 'constraints')).toMatchObject({
      actualStatus: 'unknown', note: 'bounded integer witnesses checked against native min/max/step or the known ASCII integer pattern; this is not equivalence proof',
    });
    expect(await readFile(join(item.directory, 'form.html'), 'utf8')).toBe(item.html);
    expect(JSON.parse(await readFile(join(item.directory, 'check.json'), 'utf8'))).toEqual(item.projection);
  });

  test('uses the first matching entry even when a later duplicate supports witnesses', async () => {
    const item = await fixture('<input type="number" name="quantity" readonly><input type="number" name="quantity" min="0" max="20" step="any">');
    const report = await runDoctor(item.configPath);
    expect(report.findings.filter(({ ruleId }) => ruleId === 'BC013')).toEqual([]);
    expect(report.coverage.find(({ ruleGroup }) => ruleGroup === 'constraints')).toMatchObject({
      actualStatus: 'unknown', note: 'no supported native integer constraint comparison; other constraint semantics remain unknown',
    });
  });
});
