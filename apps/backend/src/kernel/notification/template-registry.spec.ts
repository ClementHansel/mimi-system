import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TEMPLATES } from './template-registry';
import { ID_ID_NOTIFICATION_TEXT } from './i18n/id-ID';

/**
 * RISK-P4 — WhatsApp is deferred past launch (owner decision, 2026-08-29):
 * `wa.enabled` stays false, so every WhatsApp send writes an outbox row and
 * dispatches nothing.
 *
 * That is only safe because no template depends on WhatsApp ALONE, and this
 * test is what keeps it safe. A WhatsApp-only template added later would write
 * an outbox row, deliver nothing, and raise no error — the channel fails
 * closed into a `pending` row rather than throwing, so nothing would surface
 * it.
 *
 * WHAT THE TYPE SYSTEM ALREADY PROVES, so it is not re-asserted here:
 * `NOTIFICATION_TEMPLATES` is declared `as const satisfies Record<string,
 * NotificationTemplate>`, so TypeScript knows each `channels` array
 * literally. "Every template has at least one channel" is therefore a
 * compile-time fact — writing it as a runtime test produced a `TS2367`
 * "comparison appears unintentional", i.e. an assertion that could never
 * fail. It was removed rather than cast into passing; a test that cannot fail
 * is worse than no test, because it reads as coverage.
 *
 * The checks below are the ones the types do NOT cover: cross-referencing the
 * registry against the separate i18n file, and the channel-combination rule
 * that is a deployment decision rather than a shape.
 */
describe('notification template registry', () => {
  const templates = Object.values(NOTIFICATION_TEMPLATES);

  it('RISK-P4: no template depends on WhatsApp alone', () => {
    const whatsappOnly = templates
      // Widened deliberately: `as const` narrows some templates to
      // `('in_app' | 'email')[]`, where TypeScript rejects the `'whatsapp'`
      // comparison as impossible. That narrowing is per-template, so it cannot
      // express the fleet-wide invariant — this has to be a runtime sweep.
      .filter((t) => (t.channels as readonly string[]).includes('whatsapp'))
      .filter((t) => {
        const channels = t.channels as readonly string[];
        return !channels.includes('in_app') && !channels.includes('email');
      })
      .map((t) => t.key);

    expect(
      whatsappOnly,
      'WhatsApp is disabled for launch — a template with no other channel would be written to the outbox, never delivered, and never noticed',
    ).toEqual([]);
  });

  it("every template's map key matches its own `key` field", () => {
    // `getTemplate(key)` indexes by the map key while `NotificationService`
    // reports `template.key`. A mismatch makes a delivered notification cite a
    // template nobody can look up.
    const mismatched = Object.entries(NOTIFICATION_TEMPLATES)
      .filter(([mapKey, template]) => mapKey !== template.key)
      .map(([mapKey, template]) => `${mapKey} !== ${template.key}`);
    expect(mismatched).toEqual([]);
  });

  it('every template has Indonesian copy, and every placeholder in it is a declared param', () => {
    // The registry and the copy live in separate files with no type link
    // between them, so this is exactly where drift goes unnoticed. The failure
    // it catches is a notification that renders "{{locationName}}" literally
    // to an owner — a missing param does not throw, it ships.
    for (const template of templates) {
      const copy = ID_ID_NOTIFICATION_TEXT[template.key];
      expect(copy, `no id-ID copy for '${template.key}'`).toBeDefined();
      if (!copy) continue;

      const placeholders = new Set(
        [...`${copy.title} ${copy.body}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!),
      );
      const declared = new Set<string>(template.requiredParams ?? []);
      const undeclared = [...placeholders].filter((p) => !declared.has(p));
      expect(undeclared, `'${template.key}' copy uses params it does not declare`).toEqual([]);
    }
  });
});
