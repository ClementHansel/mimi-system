'use client';

import { useEffect, useState } from 'react';
import { Mail, CheckCircle2, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/components/ui/Toast';
import { Button, Card, CardContent, Checkbox, Input, Select } from '@/components/ui';
import { apiErrorText } from '@/lib/api-error';

interface EmailSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  /** Always a mask from the server — never the real password. */
  password: string | null;
  fromEmail: string;
  fromName: string | null;
  isEnabled: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

/**
 * The tenant's own outbound email (migration 264).
 *
 * Each business connects THEIR OWN Gmail: their account, their 2FA, their App
 * Password. The system then sends notifications as them rather than from one
 * shared mailbox — which is the only arrangement that works once one instance
 * serves several businesses.
 *
 * The password field starts EMPTY even when one is stored. The server returns
 * a mask, never the secret, and sending an empty password back means "keep
 * what you have" — so editing the port cannot silently destroy a working
 * credential.
 */
export function EmailSettingsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canManage = can('settings.manage');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<EmailSettings | null>(null);

  const [host, setHost] = useState('smtp.gmail.com');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [isEnabled, setIsEnabled] = useState(true);

  function load() {
    setLoading(true);
    api
      .get<EmailSettings | null>('/settings/email')
      .then((row) => {
        setSaved(row);
        if (row) {
          setHost(row.host);
          setPort(String(row.port));
          setSecure(row.secure);
          setUsername(row.username ?? '');
          setFromEmail(row.fromEmail);
          setFromName(row.fromName ?? '');
          setIsEnabled(row.isEnabled);
        }
        // `password` is deliberately NOT populated — see the component note.
      })
      .catch((err) => setError(apiErrorText(err)))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put('/settings/email', {
        host,
        port: Number(port),
        secure,
        username: username || undefined,
        // Only sent when the user actually typed one.
        password: password || undefined,
        fromEmail,
        fromName: fromName || undefined,
        isEnabled,
      });
      setPassword('');
      toast({ title: t('admin.email.saveSuccess'), variant: 'success' });
      load();
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; error: string | null }>('/settings/email/test', {});
      toast({
        title: res.ok ? t('admin.email.testOk') : t('admin.email.testFailed'),
        description: res.error ?? undefined,
        variant: res.ok ? 'success' : 'danger',
      });
      load();
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-5 flex-none text-brand-600" aria-hidden />
            <div>
              <h2 className="font-medium text-text-primary">{t('admin.email.title')}</h2>
              <p className="text-sm text-text-muted">{t('admin.email.description')}</p>
            </div>
          </div>

          {/* The Gmail-specific instructions, because "App Password" is not
              something a restaurant owner is expected to know about, and the
              2FA prerequisite is the step everyone misses. */}
          <div className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-secondary">
            <p className="font-medium text-text-primary">{t('admin.email.gmailHelpTitle')}</p>
            <ol className="mt-1 list-decimal pl-5">
              <li>{t('admin.email.gmailStep1')}</li>
              <li>{t('admin.email.gmailStep2')}</li>
              <li>{t('admin.email.gmailStep3')}</li>
            </ol>
          </div>

          {/* The last verified result. Stored server-side, so it survives a
              reload and answers "is our email actually working right now?" —
              a question nobody thinks to ask until a notification is missed. */}
          {saved?.lastTestedAt && (
            <div
              className={`flex items-center gap-2 rounded-lg p-3 text-sm ${
                saved.lastTestOk ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'
              }`}
            >
              {saved.lastTestOk ? (
                <CheckCircle2 className="size-4 flex-none" aria-hidden />
              ) : (
                <XCircle className="size-4 flex-none" aria-hidden />
              )}
              <span>
                {saved.lastTestOk ? t('admin.email.lastTestOk') : t('admin.email.lastTestFailed')}
                {saved.lastTestError ? ` — ${saved.lastTestError}` : ''}
              </span>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('admin.email.host')}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              disabled={!canManage}
            />
            <Select
              label={t('admin.email.port')}
              value={port}
              onValueChange={(v) => {
                setPort(v);
                // 465 is implicit TLS, 587 is STARTTLS. Getting this pair
                // wrong produces a connection that HANGS rather than an error,
                // so the two move together instead of being independent
                // fields a user has to reason about.
                setSecure(v === '465');
              }}
              options={[
                { value: '587', label: t('admin.email.port587') },
                { value: '465', label: t('admin.email.port465') },
              ]}
              disabled={!canManage}
            />
            <Input
              label={t('admin.email.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@gmail.com"
              disabled={!canManage}
            />
            <Input
              type="password"
              label={t('admin.email.password')}
              hint={
                saved?.password ? t('admin.email.passwordStored') : t('admin.email.passwordHint')
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={saved?.password ?? ''}
              autoComplete="new-password"
              disabled={!canManage}
            />
            <Input
              label={t('admin.email.fromEmail')}
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="you@gmail.com"
              hint={t('admin.email.fromEmailHint')}
              disabled={!canManage}
            />
            <Input
              label={t('admin.email.fromName')}
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Mimi Chicken"
              disabled={!canManage}
            />
          </div>

          <Checkbox
            checked={isEnabled}
            onCheckedChange={setIsEnabled}
            label={t('admin.email.enabled')}
            description={t('admin.email.enabledHint')}
            disabled={!canManage}
          />

          {error && <p className="text-sm text-danger-600">{error}</p>}

          {canManage && (
            <div className="flex gap-2">
              <Button onClick={save} loading={saving} disabled={!host || !fromEmail}>
                {t('common.save')}
              </Button>
              {/* Only offered once something is stored — testing an unsaved
                  form would verify credentials the server does not have. */}
              <Button variant="outline" onClick={test} loading={testing} disabled={!saved}>
                {t('admin.email.testButton')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
