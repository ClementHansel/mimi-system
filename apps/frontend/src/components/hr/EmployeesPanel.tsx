'use client';

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardContent,
  DataTable,
  Modal,
  Input,
  MoneyInput,
  StatusBadge,
  PermissionGate,
} from '@/components/ui';
import { usePermissions } from '@/lib/permissions';
import { fmtDate } from '@/lib/dates';
import type { Paginated } from '@/lib/shared-types';
import { createEmployee, listEmployees, updateEmployee } from './lib/hr-api';
import type { Employee } from './lib/types';

/** F08 `hr` — employee records (`hr.employee.read`/`.manage`, SCOPE-IN-03). */
export function EmployeesPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [data, setData] = useState<Paginated<Employee>>({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);

  function reload() {
    setLoading(true);
    listEmployees({ q: q || undefined, page: data.page })
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(reload, [q, data.page]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <Input
            placeholder={t('hr.employees.searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            wrapperClassName="w-64"
          />
          <PermissionGate permission="hr.employee.manage">
            <Button leftIcon={<UserPlus className="size-4" />} onClick={() => setCreateOpen(true)}>
              {t('hr.employees.createButton')}
            </Button>
          </PermissionGate>
        </CardContent>
      </Card>

      <DataTable
        columns={[
          { key: 'employeeNumber', header: t('hr.employees.columnNumber') },
          { key: 'name', header: t('hr.employees.columnName') },
          { key: 'position', header: t('hr.employees.columnPosition') },
          { key: 'locationName', header: t('hr.employees.columnLocation') },
          {
            key: 'joinDate',
            header: t('hr.employees.columnJoinDate'),
            render: (r) => fmtDate(r.joinDate),
          },
          {
            key: 'employmentStatus',
            header: t('hr.employees.columnStatus'),
            render: (r) => (
              <StatusBadge domain="employment" status={r.employmentStatus} size="sm" />
            ),
          },
        ]}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        onPageChange={(page) => setData((d) => ({ ...d, page }))}
        onRowClick={can('hr.employee.manage') ? (row) => setEditing(row) : undefined}
      />

      {(createOpen || editing) && (
        <EmployeeFormModal
          employee={editing}
          onClose={() => {
            setCreateOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreateOpen(false);
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function EmployeeFormModal({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    employeeNumber: employee?.employeeNumber ?? '',
    name: employee?.name ?? '',
    nik: employee?.nik ?? '',
    phone: employee?.phone ?? '',
    email: employee?.email ?? '',
    joinDate: employee?.joinDate ?? '',
    position: employee?.position ?? '',
    locationId: employee?.locationId ?? '',
  });
  const [baseSalary, setBaseSalary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (employee) {
        await updateEmployee(employee.id, {
          name: form.name,
          nik: form.nik,
          phone: form.phone,
          email: form.email,
          position: form.position,
        });
      } else {
        await createEmployee({
          employeeNumber: form.employeeNumber,
          name: form.name,
          nik: form.nik || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          joinDate: form.joinDate,
          position: form.position,
          locationId: form.locationId,
          baseSalary: baseSalary ?? '0.00',
        });
      }
      toast({
        title: t(employee ? 'hr.employees.updateSuccess' : 'hr.employees.createSuccess'),
        variant: 'success',
      });
      onSaved();
    } catch {
      setError(t('auth.genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(employee ? 'hr.employees.editTitle' : 'hr.employees.createTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!employee && (
          <Input
            label={t('hr.employees.number')}
            value={form.employeeNumber}
            onChange={(e) => setForm((f) => ({ ...f, employeeNumber: e.target.value }))}
            required
          />
        )}
        <Input
          label={t('hr.employees.name')}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
        />
        <Input
          label={t('hr.employees.nik')}
          value={form.nik}
          onChange={(e) => setForm((f) => ({ ...f, nik: e.target.value }))}
        />
        <Input
          label={t('hr.employees.phone')}
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
        />
        <Input
          label={t('hr.employees.email')}
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <Input
          label={t('hr.employees.position')}
          value={form.position}
          onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}
          required
        />
        {!employee && (
          <>
            <Input
              type="date"
              label={t('hr.employees.joinDate')}
              value={form.joinDate}
              onChange={(e) => setForm((f) => ({ ...f, joinDate: e.target.value }))}
              required
            />
            <Input
              label={t('hr.employees.locationId')}
              value={form.locationId}
              onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))}
              required
              hint={t('hr.employees.locationIdHint')}
            />
            <MoneyInput
              label={t('hr.employees.baseSalary')}
              value={baseSalary}
              onChange={setBaseSalary}
              required
            />
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}
    </Modal>
  );
}
