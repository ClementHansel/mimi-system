'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageUp, RotateCcw, Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  documentPalette,
  isHexColor,
  normalizeHex,
  putBrandIdentity,
  putCompanyLogo,
  useBrand,
} from '@/lib/brand';
import { resolveAttachmentUrl } from '@/lib/attachment-url';
import {
  BRAND_FAVICON_KIND,
  BRAND_LOGO_KIND,
  uploadAttachment,
} from '@/components/admin/lib/attachments';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import {
  DEFAULT_BRAND_IDENTITY,
  DEFAULT_BRAND_PALETTE,
  defaultDocTemplate,
  type BrandIdentity,
} from '@/lib/shared-types';
import { DocumentRenderer } from '@/components/documents/DocumentRenderer';
import { sampleDocData } from '@/components/documents/sample-data';
import { apiErrorDetail, apiErrorText } from '@/lib/api-error';

/**
 * Admin → Merek: the logo, the favicon, and the four colours every printed
 * document and the running UI are drawn from.
 *
 * ── ONE PANEL, TWO SETTINGS KEYS ─────────────────────────────────────────────
 * The logo lives on `company.profile.logoAttachmentId` and everything else on
 * `brand.identity`. `packages/shared/src/brand.ts` records why the logo was NOT
 * duplicated into `brand.identity` (two places to set one thing; the first
 * screen to read the wrong one prints a blank letterhead), and this panel is
 * where that decision is paid for: it writes both keys so an owner never has to
 * know there are two.
 *
 * THE `company.profile` WRITE IS A MERGE, NOT A REPLACE. That object carries
 * fields this panel knows nothing about (company name, address, NPWP — edited
 * from Admin → Pengaturan). `SettingDetailModal.buildValue` already documents
 * this exact hazard for the generic settings editor ("a value may carry fields
 * the registry does not know about … dropping them on save would be a silent
 * data loss"); `putCompanyLogo` preserves the same property here, and the
 * profile it merges into is the one `BrandProvider` read, so a stale copy
 * cannot be resurrected between read and write.
 *
 * ── WHY THE PREVIEW IS A REAL DOCUMENT ───────────────────────────────────────
 * Four colour swatches tell an owner nothing about what they have just done.
 * The preview renders the seeded INVOICE through the actual `DocumentRenderer`
 * with the actual sample data, so the thing being judged is the thing that
 * prints: the heading in `brand.primary`, the table header fill and the ink
 * the renderer derives against it, the muted rules, the accent. Choosing the
 * invoice specifically (rather than, say, the voucher card) is because it is
 * the only seeded template that exercises all four tokens at once.
 */

type ColorKey = 'primaryColor' | 'accentColor' | 'inkColor' | 'mutedColor';

const COLOR_FIELDS: { key: ColorKey; labelKey: string; hintKey: string }[] = [
  { key: 'primaryColor', labelKey: 'brand.primaryColor', hintKey: 'brand.primaryColorHint' },
  { key: 'accentColor', labelKey: 'brand.accentColor', hintKey: 'brand.accentColorHint' },
  { key: 'inkColor', labelKey: 'brand.inkColor', hintKey: 'brand.inkColorHint' },
  { key: 'mutedColor', labelKey: 'brand.mutedColor', hintKey: 'brand.mutedColorHint' },
];

/** Preview scale — an A4 sheet is 794px wide and has to fit a settings column. */
const PREVIEW_SCALE = 0.34;

export function BrandPanel() {
  const { t } = useI18n();
  const { identity, companyProfile, logoUrl, loaded, refresh } = useBrand();

  const [draft, setDraft] = useState<BrandIdentity>(identity);
  const [logoId, setLogoId] = useState<string | null>(
    typeof companyProfile.logoAttachmentId === 'string' ? companyProfile.logoAttachmentId : null,
  );
  const [previewLogoUrl, setPreviewLogoUrl] = useState<string | null>(logoUrl);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'logo' | 'favicon' | null>(null);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);

  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);

  // The provider loads asynchronously; adopt its value once, when it lands.
  // Keyed on `loaded` rather than on `identity` so a later provider refresh
  // (triggered by this panel's own save) cannot stomp an edit in progress.
  useEffect(() => {
    if (!loaded) return;
    setDraft(identity);
    setLogoId(
      typeof companyProfile.logoAttachmentId === 'string' ? companyProfile.logoAttachmentId : null,
    );
    setPreviewLogoUrl(logoUrl);
    // Intentionally keyed on `loaded` ALONE. `identity`/`companyProfile`/
    // `logoUrl` are read here but are deliberately NOT dependencies: this
    // effect exists to adopt the provider's value ONCE, when the first fetch
    // lands. Listing them would make a later provider refresh — the one this
    // panel itself triggers after saving — re-run the effect and overwrite an
    // edit the owner has in progress.
  }, [loaded]);

  useEffect(() => {
    let cancelled = false;
    void resolveAttachmentUrl(draft.faviconAttachmentId).then((url) => {
      if (!cancelled) setFaviconUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [draft.faviconAttachmentId]);

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(identity) ||
    logoId !== (companyProfile.logoAttachmentId ?? null);

  const invalid = COLOR_FIELDS.some(({ key }) => !isHexColor(draft[key]));

  const previewTemplate = useMemo(() => defaultDocTemplate('invoice'), []);
  const previewData = useMemo(
    () =>
      sampleDocData('invoice', documentPalette(draft, DEFAULT_BRAND_PALETTE), {
        logoUrl: previewLogoUrl,
        t,
      }),
    [draft, previewLogoUrl, t],
  );

  async function upload(kind: 'logo' | 'favicon', file: File) {
    setUploading(kind);
    try {
      const attachmentId = await uploadAttachment(
        file,
        kind === 'logo' ? BRAND_LOGO_KIND : BRAND_FAVICON_KIND,
      );
      if (kind === 'logo') {
        setLogoId(attachmentId);
        // Resolve immediately so the preview updates before Save — an owner
        // must be able to see the mark on the letterhead while deciding
        // whether to keep it.
        setPreviewLogoUrl(await resolveAttachmentUrl(attachmentId));
      } else {
        setDraft((current) => ({ ...current, faviconAttachmentId: attachmentId }));
      }
    } catch (err) {
      toast({
        title: t('brand.uploadFailed'),
        description: apiErrorDetail(err),
        variant: 'danger',
      });
    } finally {
      setUploading(null);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // The two keys are written in sequence, identity FIRST. If the second
      // write fails the owner is left with the new colours and the old logo —
      // a visibly incomplete save they can retry — rather than with a new logo
      // and colours that silently did not take. There is no transaction across
      // two settings keys and inventing one client-side would be a lie.
      await putBrandIdentity(draft);
      if (logoId !== (companyProfile.logoAttachmentId ?? null)) {
        await putCompanyLogo(companyProfile, logoId);
      }
      await refresh();
      toast({ title: t('brand.saved'), variant: 'success' });
    } catch (err) {
      toast({
        title: t('brand.saveFailed'),
        description: apiErrorText(err),
        variant: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }

  /**
   * Resets the COLOURS only, and leaves the logo and favicon alone.
   *
   * "Reset to default" for an uploaded image would mean deleting the company's
   * own mark, which is not a thing anybody reaches for a reset button
   * expecting. Removing an image has its own explicit button next to the image
   * it removes.
   */
  function resetColors() {
    setDraft((current) => ({
      ...current,
      primaryColor: DEFAULT_BRAND_IDENTITY.primaryColor,
      accentColor: DEFAULT_BRAND_IDENTITY.accentColor,
      inkColor: DEFAULT_BRAND_IDENTITY.inkColor,
      mutedColor: DEFAULT_BRAND_IDENTITY.mutedColor,
    }));
    toast({ title: t('brand.resetDone'), variant: 'success' });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-lg font-semibold">{t('brand.title')}</h2>
        <p className="text-sm text-text-secondary">{t('brand.description')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {/* Images */}
          <Card>
            <CardHeader>
              <CardTitle>{t('brand.logoTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{t('brand.logoHint')}</p>
              <div className="flex items-center gap-4">
                <div className="flex size-24 items-center justify-center rounded-md border border-border bg-surface-sunken p-2">
                  {previewLogoUrl ? (
                    // A plain <img>: the src is a presigned, expiring MinIO url
                    // that `next/image` would try to optimise through its own
                    // loader and fail on. Same reason `MasterDataPanel` gives
                    // for the product photo.
                    <img
                      src={previewLogoUrl}
                      alt=""
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-text-muted">{t('brand.logoEmpty')}</span>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void upload('logo', file);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    loading={uploading === 'logo'}
                    leftIcon={<ImageUp className="size-4" />}
                    onClick={() => logoInputRef.current?.click()}
                  >
                    {t(logoId ? 'brand.logoReplace' : 'brand.logoUpload')}
                  </Button>
                  {logoId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setLogoId(null);
                        setPreviewLogoUrl(null);
                      }}
                    >
                      {t('brand.logoRemove')}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('brand.faviconTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{t('brand.faviconHint')}</p>
              <div className="flex items-center gap-4">
                <div className="flex size-16 items-center justify-center rounded-md border border-border bg-surface-sunken p-2">
                  {faviconUrl ? (
                    <img src={faviconUrl} alt="" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-center text-[10px] leading-tight text-text-muted">
                      {t('brand.faviconEmpty')}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <input
                    ref={faviconInputRef}
                    type="file"
                    accept="image/png,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void upload('favicon', file);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    loading={uploading === 'favicon'}
                    leftIcon={<ImageUp className="size-4" />}
                    onClick={() => faviconInputRef.current?.click()}
                  >
                    {t(draft.faviconAttachmentId ? 'brand.faviconReplace' : 'brand.faviconUpload')}
                  </Button>
                  {draft.faviconAttachmentId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft((current) => ({ ...current, faviconAttachmentId: null }))
                      }
                    >
                      {t('brand.faviconRemove')}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Colours */}
          <Card>
            <CardHeader>
              <CardTitle>{t('brand.colorsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-text-secondary">{t('brand.colorsHint')}</p>
              {COLOR_FIELDS.map(({ key, labelKey, hintKey }) => {
                const value = draft[key];
                const valid = isHexColor(value);
                return (
                  <div key={key} className="flex items-end gap-3">
                    <input
                      type="color"
                      aria-label={t(labelKey)}
                      value={normalizeHex(value) ?? '#000000'}
                      onChange={(e) => setDraft((c) => ({ ...c, [key]: e.target.value }))}
                      className="size-10 flex-none cursor-pointer rounded-md border border-border bg-transparent p-0"
                    />
                    {/* The hex is editable as TEXT too, not just through the
                        swatch: a brand colour arrives from a designer as
                        "#a8481a" in an email, and hunting for it in a colour
                        wheel is both slow and inexact. */}
                    <Input
                      label={t(labelKey)}
                      hint={t(hintKey)}
                      error={valid ? undefined : t('brand.invalidColor')}
                      value={value}
                      onChange={(e) => setDraft((c) => ({ ...c, [key]: e.target.value }))}
                      wrapperClassName="flex-1"
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-warning-700">{t('brand.unsaved')}</span>}
            <Button
              className="ml-auto"
              variant="outline"
              leftIcon={<RotateCcw className="size-4" />}
              onClick={resetColors}
            >
              {t('brand.resetToDefault')}
            </Button>
            <Button
              loading={saving}
              disabled={invalid}
              leftIcon={<Save className="size-4" />}
              onClick={save}
            >
              {t('brand.save')}
            </Button>
          </div>
        </div>

        {/* Live document preview */}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('brand.previewTitle')}</h3>
          <p className="text-xs text-text-muted">{t('brand.previewHint')}</p>
          <div className="overflow-auto rounded-lg border border-border bg-surface-sunken p-3">
            <DocumentRenderer
              template={previewTemplate}
              data={previewData}
              scale={PREVIEW_SCALE}
              className="mx-auto shadow-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
