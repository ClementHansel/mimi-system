import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { translate } from '@/lib/i18n';
import { ANOMALY_DETECTORS } from './anomaly-types';

/**
 * The backend emits the vocabulary the panel translates — detector keys,
 * `metric`s, drill-down column keys, threshold parameter names. None of those
 * is a literal `t('…')` call, so `literal-keys.test.ts` cannot see them, and a
 * missing one renders as its KEY (`dashboard.anomaly.cols.settlement`) in
 * production with no console warning. So this reads the backend source and
 * demands a sentence for everything it can emit.
 */
const BACKEND = resolve(__dirname, '../../../../../backend/src/modules/dashboard/anomalies');

/** LF-normalised: a Windows checkout (core.autocrlf) hands these files back CRLF and the patterns below match line ends. */
function source(path: string): string {
  return readFileSync(path, 'utf8').split('\r\n').join('\n');
}

function read(...parts: string[]): string {
  return source(join(BACKEND, ...parts));
}

const has = (key: string) => translate(key) !== key;

describe('Anomali vocabulary is fully translated', () => {
  it('finds the backend sources at all', () => {
    expect(read('anomaly.types.ts')).toContain('ANOMALY_DETECTORS');
  });

  it('the frontend and backend agree on the detector list', () => {
    const src = read('anomaly.types.ts');
    const block = /ANOMALY_DETECTORS = \[([\s\S]*?)\] as const/.exec(src)![1]!;
    const backend = [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(backend).toEqual([...ANOMALY_DETECTORS]);
  });

  it('every detector has a label and a hint', () => {
    for (const k of ANOMALY_DETECTORS) {
      expect(has(`dashboard.anomaly.detectors.${k}.label`), k).toBe(true);
      expect(has(`dashboard.anomaly.detectors.${k}.hint`), k).toBe(true);
    }
  });

  it('every drill-down column key the backend emits has a header', () => {
    const keys = new Set([...read('drilldown.ts').matchAll(/\bcol\('(\w+)'/g)].map((m) => m[1]!));
    expect(keys.size).toBeGreaterThan(20);
    for (const k of keys) expect(has(`dashboard.anomaly.cols.${k}`), `cols.${k}`).toBe(true);
  });

  it('every metric a detector emits has a label and a sentence', () => {
    const detectorsDir = join(BACKEND, 'detectors');
    const metrics = new Set<string>();
    for (const f of readdirSync(detectorsDir)) {
      for (const m of source(join(detectorsDir, f)).matchAll(
        /\bmetric: (?:[^'\n]*\? )?'(\w+)'(?: : '(\w+)')?/g,
      )) {
        metrics.add(m[1]!);
        if (m[2]) metrics.add(m[2]);
      }
    }
    expect([...metrics].sort()).toEqual(
      [
        'balance',
        'cash_growth_days',
        'deductions',
        'net_pay',
        'qty',
        'revenue',
        'settlement',
        'stock_variance',
        'unit_price',
        'usage',
      ].sort(),
    );
    for (const m of metrics) {
      expect(has(`dashboard.anomaly.metric.${m}`), `metric.${m}`).toBe(true);
    }
    // sentences: revenue and stock_variance have two variants
    expect(has('dashboard.anomaly.detail.revenue.high')).toBe(true);
    expect(has('dashboard.anomaly.detail.revenue.low')).toBe(true);
    expect(has('dashboard.anomaly.detail.stock_variance.share')).toBe(true);
    expect(has('dashboard.anomaly.detail.stock_variance.over')).toBe(true);
    for (const m of metrics) {
      if (m === 'revenue' || m === 'stock_variance') continue;
      expect(has(`dashboard.anomaly.detail.${m}`), `detail.${m}`).toBe(true);
    }
  });

  it('every threshold parameter has a label in the dialog', () => {
    const src = read('anomaly-thresholds.ts');
    const fields = [...src.matchAll(/detector: '(\w+)', key: '(\w+)'/g)];
    expect(fields.length).toBeGreaterThan(14);
    for (const [, detector, key] of fields) {
      expect(has(`dashboard.anomaly.params.${detector}.${key}`), `${detector}.${key}`).toBe(true);
    }
  });

  it('every {{placeholder}} in a sentence is one the backend actually sends', () => {
    // A placeholder with no value renders as the literal "{{name}}". Check each
    // sentence's placeholders against the keys its detector puts in `detail`
    // (plus the `actual`/`expected` the panel always adds).
    const detail = new Map<string, Set<string>>();
    const detectorsDir = join(BACKEND, 'detectors');
    for (const f of readdirSync(detectorsDir)) {
      const src = source(join(detectorsDir, f));
      for (const block of src.matchAll(
        /metric: ([^\n]*)\n[\s\S]*?detail: \{([\s\S]*?)\},\n\s*ref:/g,
      )) {
        const keys = [...block[2]!.matchAll(/(?:^|[\s,{])(\w+)(?::|,)/g)].map((m) => m[1]!);
        for (const metric of [...block[1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!)) {
          const set = detail.get(metric) ?? new Set<string>();
          keys.forEach((k) => set.add(k));
          detail.set(metric, set);
        }
      }
    }
    const sentenceKeys: Record<string, string[]> = {
      revenue: ['revenue.high', 'revenue.low'],
      stock_variance: ['stock_variance.share', 'stock_variance.over'],
    };
    for (const [metric, keys] of detail) {
      for (const k of sentenceKeys[metric] ?? [metric]) {
        const text = translate(`dashboard.anomaly.detail.${k}`);
        for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
          const name = m[1]!;
          const sent = new Set([...keys, 'actual', 'expected']);
          expect(
            sent.has(name),
            `detail.${k} uses {{${name}}} but the backend sends ${[...sent].join(', ')}`,
          ).toBe(true);
        }
      }
    }
    expect(detail.size).toBeGreaterThanOrEqual(9);
  });
});
