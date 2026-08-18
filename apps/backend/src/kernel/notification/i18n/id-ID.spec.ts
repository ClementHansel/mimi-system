import { describe, it, expect } from 'vitest';
import { ID_ID_NOTIFICATION_TEXT, renderNotificationText } from './id-ID';
import { NOTIFICATION_TEMPLATES } from '../template-registry';

describe('renderNotificationText', () => {
  it('interpolates every {{param}} placeholder with the supplied value', () => {
    const result = renderNotificationText('low_stock', {
      itemName: 'Ayam Fillet',
      locationName: 'Gudang Pusat Balikpapan',
      currentQty: '5.000',
      minQty: '20.000',
      unit: 'kg',
    });
    expect(result.title).toBe('Stok menipis: Ayam Fillet');
    expect(result.body).toBe(
      'Ayam Fillet di Gudang Pusat Balikpapan tersisa 5.000 kg (minimum 20.000 kg). Segera ajukan permintaan barang.',
    );
  });

  it('leaves a placeholder untouched when its param is missing, rather than throwing', () => {
    const result = renderNotificationText('low_stock', { itemName: 'Ayam Fillet' });
    expect(result.title).toBe('Stok menipis: Ayam Fillet');
    expect(result.body).toContain('{{locationName}}');
  });

  it('degrades to the key itself for an unknown template key', () => {
    const result = renderNotificationText('nonexistent_template', {});
    expect(result.title).toBe('nonexistent_template');
    expect(result.body).toBe('');
  });

  it('is Indonesian text only in this one module — not asserted directly, but every registry template has a matching i18n entry', () => {
    for (const key of Object.keys(NOTIFICATION_TEMPLATES)) {
      expect(
        ID_ID_NOTIFICATION_TEXT[key],
        `missing i18n entry for template '${key}'`,
      ).toBeDefined();
    }
  });
});

describe('NOTIFICATION_TEMPLATES × id-ID consistency', () => {
  it('every requiredParams entry appears as a {{placeholder}} in its own title or body', () => {
    for (const template of Object.values(NOTIFICATION_TEMPLATES)) {
      const text = ID_ID_NOTIFICATION_TEXT[template.key]!;
      const combined = text.title + text.body;
      for (const param of template.requiredParams) {
        expect(
          combined,
          `template '${template.key}' declares required param '${param}' but never uses it`,
        ).toContain(`{{${param}}}`);
      }
    }
  });
});
