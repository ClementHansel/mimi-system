'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Button, Input, Modal, Textarea, toast } from '@/components/ui';
import { errMsg } from '@/lib/api-error';
import { createSupplier, updateSupplier } from './lib/api';
import type { Supplier } from './lib/types';

/**
 * FR-SUP-01 — create or edit a supplier.
 *
 * `code` is editable on create and LOCKED on edit: it is the human key that
 * appears on purchase orders already issued, and letting it change silently
 * re-labels historical documents.
 *
 * `outletVisible` (D-20, Amendment 3) gets a full explanation rather than a
 * bare switch, because what it does is not guessable from its name and the
 * consequence is a privacy one: it exposes this supplier's NAME and CONTACT to
 * outlet supervisors and leaders so they can pick it on a petty-cash form.
 * Price, payment terms and bank details are stripped by the API for those
 * roles whether the flag is on or off, which is the part someone toggling it
 * needs to be sure of.
 */
export function SupplierFormModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isEdit = supplier !== null;

  const [code, setCode] = useState(supplier?.code ?? '');
  const [name, setName] = useState(supplier?.name ?? '');
  const [contactName, setContactName] = useState(supplier?.contactName ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [email, setEmail] = useState(supplier?.email ?? '');
  const [address, setAddress] = useState(supplier?.address ?? '');
  const [paymentTermsDays, setPaymentTermsDays] = useState(String(supplier?.paymentTermsDays ?? 0));
  const [bankName, setBankName] = useState(supplier?.bankName ?? '');
  const [bankAccount, setBankAccount] = useState(supplier?.bankAccount ?? '');
  const [bankAccountName, setBankAccountName] = useState(supplier?.bankAccountName ?? '');
  const [outletVisible, setOutletVisible] = useState(supplier?.outletVisible ?? false);
  const [saving, setSaving] = useState(false);

  const termsDays = Number.parseInt(paymentTermsDays, 10);
  const termsValid = Number.isInteger(termsDays) && termsDays >= 0;
  const canSubmit = code.trim().length > 0 && name.trim().length > 0 && termsValid && !saving;

  /** Empty text inputs are sent as null, not `''` — the columns are nullable and a blank string would read as "there IS a contact, and it is nothing". */
  const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    const body = {
      code: code.trim(),
      name: name.trim(),
      contactName: orNull(contactName),
      phone: orNull(phone),
      email: orNull(email),
      address: orNull(address),
      paymentTermsDays: termsDays,
      bankName: orNull(bankName),
      bankAccount: orNull(bankAccount),
      bankAccountName: orNull(bankAccountName),
      outletVisible,
    };
    try {
      if (isEdit) {
        // `code` is deliberately excluded from the update body.
        const { code: _omitted, ...rest } = body;
        void _omitted;
        await updateSupplier(supplier.id, rest);
      } else {
        await createSupplier(body);
      }
      toast({
        title: t(isEdit ? 'purchasing.suppliers.updated' : 'purchasing.suppliers.created'),
        variant: 'success',
      });
      onSaved();
    } catch (err) {
      // The realistic failure here is a duplicate `code`, and it has to SAY
      // so — "gagal menyimpan" would send someone hunting for the wrong
      // problem. It used to say so in the driver's words
      // (`duplicate key value violates unique constraint "suppliers_code_key"`);
      // `apiErrorText` reads the same 409's `code`+`details.field` and
      // produces «Kode "SUP001" sudah dipakai. Gunakan yang lain.»
      toast({
        title: errMsg(err, t('purchasing.suppliers.saveFailed')),
        variant: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(isEdit ? 'purchasing.suppliers.editTitle' : 'purchasing.suppliers.createTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!canSubmit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('purchasing.suppliers.fieldCode')} required>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isEdit}
            placeholder="SUP-001"
          />
          {isEdit && (
            <p className="mt-1 text-xs text-text-muted">{t('purchasing.suppliers.codeLocked')}</p>
          )}
        </Field>
        <Field label={t('purchasing.suppliers.fieldName')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('purchasing.suppliers.fieldContact')}>
          <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label={t('purchasing.suppliers.fieldPhone')}>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </Field>
        <Field label={t('purchasing.suppliers.fieldEmail')}>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </Field>
        <Field label={t('purchasing.suppliers.fieldTerms')} required>
          <Input
            value={paymentTermsDays}
            onChange={(e) => setPaymentTermsDays(e.target.value)}
            inputMode="numeric"
          />
          <p className="mt-1 text-xs text-text-muted">{t('purchasing.suppliers.termsHint')}</p>
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('purchasing.suppliers.fieldAddress')}>
            <Textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} />
          </Field>
        </div>
        <Field label={t('purchasing.suppliers.fieldBankName')}>
          <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
        </Field>
        <Field label={t('purchasing.suppliers.fieldBankAccount')}>
          <Input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('purchasing.suppliers.fieldBankAccountName')}>
            <Input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <label className="flex items-start gap-2.5 rounded-lg border border-border p-3">
            <input
              type="checkbox"
              checked={outletVisible}
              onChange={(e) => setOutletVisible(e.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>
              <span className="block text-sm font-medium text-text-primary">
                {t('purchasing.suppliers.fieldOutletVisible')}
              </span>
              <span className="block text-xs text-text-secondary">
                {t('purchasing.suppliers.outletVisibleHint')}
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-text-primary">
        {label}
        {required && <span className="text-danger-600"> *</span>}
      </span>
      {children}
    </label>
  );
}
