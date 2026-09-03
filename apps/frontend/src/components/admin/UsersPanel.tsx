'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, UserPlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, type Paginated } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn, type DataTableSort } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { Checkbox } from '@/components/ui/Checkbox';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { ExportButton } from '@/components/common/ExportButton';
import { useApiList } from './useApiList';
import { RoleKey } from '@/lib/shared-types';
import { ROLE_SENIORITY, assignableRoles, roleLabel } from './roleRank';
import { userIoColumns } from './lib/io-columns';
import type { Location, UserRow } from './types';
import { errMsg } from '@/lib/api-error';

/**
 * F10 admin — Users (CONTRACTS §4.2 M02). List/create/edit/role-assign
 * (rank-checked)/location-assign/reset-password/deactivate. All of the
 * mutating actions are individually `PermissionGate`d because the 9-role
 * matrix splits them (e.g. a user with `user.read` but not `user.create` can
 * still open this screen, just can't see the "Tambah" button) — none of that
 * gating is the real boundary, the server's `PermissionsGuard` is.
 */
function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useI18n();
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-50 px-2.5 py-1 text-sm font-medium text-success-700">
      <CheckCircle2 className="size-3.5" aria-hidden /> {t('admin.users.statusActive')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-sm font-medium text-stone-600">
      <XCircle className="size-3.5" aria-hidden /> {t('admin.users.statusInactive')}
    </span>
  );
}

export function UsersPanel() {
  const { t } = useI18n();
  const { can, roleKey } = usePermissions();

  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<DataTableSort | undefined>(undefined);

  const { data, loading, error, reload } = useApiList<UserRow>('/users', {
    q,
    roleKey: roleFilter,
    active: statusFilter,
    page,
    pageSize,
  });

  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api
      .get<{ rows: Location[] }>('/locations?active=true&pageSize=200')
      .then((res) => setLocations(res.rows))
      .catch(() => {});
  }, []);

  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);

  /**
   * Server-paginated (25/page default), so "Ekspor" alone would silently
   * ship one page. `pageSize=200` (the repository's `Math.min(pageSize,
   * 200)`) with a 200-page ceiling matches
   * `purchasing/SupplierPriceHistoryPanel`'s convention.
   */
  async function fetchAllUsers(): Promise<UserRow[]> {
    const all: UserRow[] = [];
    const size = 200;
    for (let p = 1; p <= 200; p += 1) {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(size) });
      if (q) qs.set('q', q);
      if (roleFilter) qs.set('roleKey', roleFilter);
      if (statusFilter) qs.set('active', statusFilter);
      const res = await api.get<Paginated<UserRow>>(`/users?${qs}`);
      all.push(...res.rows);
      if (res.rows.length < size || all.length >= res.total) break;
    }
    return all;
  }

  const columns: DataTableColumn<UserRow>[] = [
    { key: 'username', header: t('admin.users.columnUsername'), sortable: true },
    { key: 'name', header: t('admin.users.columnName'), sortable: true },
    { key: 'roleName', header: t('admin.users.columnRole'), render: (r) => roleLabel(r.roleKey) },
    {
      key: 'locations',
      header: t('admin.users.columnLocations'),
      render: (r) => (r.locations.length ? r.locations.map((l) => l.name).join(', ') : '—'),
    },
    {
      key: 'isActive',
      header: t('admin.users.columnStatus'),
      render: (r) => <ActiveBadge active={r.isActive} />,
    },
    {
      key: 'lastLoginAt',
      header: t('admin.users.columnLastLogin'),
      render: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : t('admin.users.never')),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            placeholder={t('admin.users.searchPlaceholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-64"
          />
          <Select
            value={roleFilter}
            onValueChange={(v) => {
              setRoleFilter(v);
              setPage(1);
            }}
            placeholder={t('admin.users.filterRole')}
            options={ROLE_SENIORITY.map((r) => ({ value: r, label: roleLabel(r) }))}
            wrapperClassName="w-44"
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            placeholder={t('admin.users.filterStatus')}
            options={[
              { value: 'true', label: t('admin.users.statusActive') },
              { value: 'false', label: t('admin.users.statusInactive') },
            ]}
            wrapperClassName="w-40"
          />
        </div>
        <div className="flex items-center gap-2">
          {/* Export only, deliberately — no bulk import. `users` (the login
              record) is not one of the backend importer's nine entities: a
              natural-key upsert cannot safely carry a password, a
              rank-checked role assignment, and a location grant in one CSV
              row. `employees` (payroll/HR data) is a separate concept and
              already has its own import via Data Master. */}
          <ExportButton
            rows={data.rows}
            columns={userIoColumns()}
            filenameBase="pengguna"
            fetchAll={fetchAllUsers}
          />
          <PermissionGate permission="user.create">
            <Button leftIcon={<UserPlus className="size-4" />} onClick={() => setCreateOpen(true)}>
              {t('admin.users.createButton')}
            </Button>
          </PermissionGate>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('admin.users.description')}
        onRowClick={(r) => setSelected(r)}
        sort={sort}
        onSortChange={(key) =>
          setSort((s) => ({
            key,
            direction: s?.key === key && s.direction === 'asc' ? 'desc' : 'asc',
          }))
        }
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {createOpen && (
        <CreateUserModal
          locations={locations}
          callerRoleKey={roleKey}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
            toast({ title: t('admin.users.createSuccess'), variant: 'success' });
          }}
        />
      )}

      {selected && (
        <UserDrawer
          user={selected}
          locations={locations}
          callerRoleKey={roleKey}
          canUpdate={can('user.update')}
          canAssignRole={can('user.role.assign')}
          canAssignLocations={can('user.location.assign')}
          canResetPassword={can('user.password.reset')}
          canDeactivate={can('user.deactivate')}
          onClose={() => setSelected(null)}
          onChanged={(updated) => {
            setSelected(updated);
            reload();
          }}
          onDeactivated={() => {
            setSelected(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({
  locations,
  callerRoleKey,
  onClose,
  onCreated,
}: {
  locations: Location[];
  callerRoleKey: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const assignable = assignableRoles(callerRoleKey);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(assignable[0] ?? '');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/users', {
        username,
        name,
        email: email || undefined,
        phone: phone || undefined,
        password,
        roleKey: role,
        locationIds,
      });
      onCreated();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.users.createTitle')}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!username || !name || !password || !role}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={t('admin.users.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <Input
            label={t('admin.users.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            label={t('admin.users.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label={t('admin.users.phone')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label={t('admin.users.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Select
            label={t('admin.users.role')}
            value={role}
            onValueChange={setRole}
            options={assignable.map((r) => ({ value: r, label: roleLabel(r) }))}
            hint={t('admin.users.rankWarning')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-primary">
            {t('admin.users.locations')}
          </span>
          <span className="text-sm text-text-muted">{t('admin.users.selectLocationsHint')}</span>
          {role === RoleKey.MANAGER && (
            <span className="text-sm text-text-muted">{t('admin.users.managerScopeHint')}</span>
          )}
          <div className="max-h-40 overflow-y-auto rounded-md border border-border-strong p-2">
            {locations.map((loc) => (
              <Checkbox
                key={loc.id}
                label={`${loc.name} (${loc.code})`}
                checked={locationIds.includes(loc.id)}
                onCheckedChange={(checked) =>
                  setLocationIds((ids) =>
                    checked ? [...ids, loc.id] : ids.filter((id) => id !== loc.id),
                  )
                }
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function UserDrawer({
  user,
  locations,
  callerRoleKey,
  canUpdate,
  canAssignRole,
  canAssignLocations,
  canResetPassword,
  canDeactivate,
  onClose,
  onChanged,
  onDeactivated,
}: {
  user: UserRow;
  locations: Location[];
  callerRoleKey: string | null;
  canUpdate: boolean;
  canAssignRole: boolean;
  canAssignLocations: boolean;
  canResetPassword: boolean;
  canDeactivate: boolean;
  onClose: () => void;
  onChanged: (u: UserRow) => void;
  onDeactivated: () => void;
}) {
  const { t } = useI18n();
  const assignable = assignableRoles(callerRoleKey);

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [role, setRole] = useState(user.roleKey);
  const [locationIds, setLocationIds] = useState(user.locations.map((l) => l.id));
  const [newPassword, setNewPassword] = useState('');
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveProfile() {
    setBusy('profile');
    setError(null);
    try {
      const updated = await api.patch<UserRow>(`/users/${user.id}`, {
        name,
        email: email || null,
        phone: phone || null,
      });
      onChanged(updated);
      toast({ title: t('admin.users.updateSuccess'), variant: 'success' });
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(null);
    }
  }

  async function saveRole() {
    setBusy('role');
    setError(null);
    try {
      const updated = await api.put<UserRow>(`/users/${user.id}/role`, { roleKey: role });
      onChanged(updated);
      toast({ title: t('admin.users.roleUpdateSuccess'), variant: 'success' });
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(null);
    }
  }

  async function saveLocations() {
    setBusy('locations');
    setError(null);
    try {
      const updated = await api.put<UserRow>(`/users/${user.id}/locations`, { locationIds });
      onChanged(updated);
      toast({ title: t('admin.users.locationsUpdateSuccess'), variant: 'success' });
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(null);
    }
  }

  async function resetPassword() {
    setBusy('password');
    setError(null);
    try {
      await api.post(`/users/${user.id}/reset-password`, { newPassword });
      setNewPassword('');
      toast({ title: t('admin.users.passwordResetSuccess'), variant: 'success' });
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(null);
    }
  }

  async function deactivate() {
    setBusy('deactivate');
    setError(null);
    try {
      await api.delete(`/users/${user.id}`);
      toast({ title: t('admin.users.deactivateSuccess'), variant: 'success' });
      onDeactivated();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
      setBusy(null);
    }
  }

  return (
    <Drawer open onClose={onClose} title={user.name} size="lg">
      <div className="flex flex-col gap-6">
        {error && <p className="text-sm text-danger-600">{error}</p>}

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text-primary">{t('admin.users.editTitle')}</h3>
          <Input label={t('admin.users.username')} value={user.username} disabled />
          <Input
            label={t('admin.users.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canUpdate}
          />
          <Input
            label={t('admin.users.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!canUpdate}
          />
          <Input
            label={t('admin.users.phone')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={!canUpdate}
          />
          {canUpdate && (
            <Button
              size="sm"
              onClick={saveProfile}
              loading={busy === 'profile'}
              className="self-start"
            >
              {t('common.save')}
            </Button>
          )}
        </section>

        {canAssignRole && (
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('admin.users.assignRole')}
            </h3>
            <Select
              value={role}
              onValueChange={setRole}
              options={[
                ...(assignable.some((r) => r === user.roleKey)
                  ? []
                  : [{ value: user.roleKey, label: roleLabel(user.roleKey), disabled: true }]),
                ...assignable.map((r) => ({ value: r, label: roleLabel(r) })),
              ]}
              hint={t('admin.users.rankWarning')}
            />
            <Button
              size="sm"
              onClick={saveRole}
              loading={busy === 'role'}
              disabled={role === user.roleKey}
              className="self-start"
            >
              {t('common.save')}
            </Button>
          </section>
        )}

        {canAssignLocations && (
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('admin.users.assignLocations')}
            </h3>
            {user.roleKey === RoleKey.MANAGER && (
              <span className="text-sm text-text-muted">{t('admin.users.managerScopeHint')}</span>
            )}
            <div className="max-h-40 overflow-y-auto rounded-md border border-border-strong p-2">
              {locations.map((loc) => (
                <Checkbox
                  key={loc.id}
                  label={`${loc.name} (${loc.code})`}
                  checked={locationIds.includes(loc.id)}
                  onCheckedChange={(checked) =>
                    setLocationIds((ids) =>
                      checked ? [...ids, loc.id] : ids.filter((id) => id !== loc.id),
                    )
                  }
                />
              ))}
            </div>
            <Button
              size="sm"
              onClick={saveLocations}
              loading={busy === 'locations'}
              className="self-start"
            >
              {t('common.save')}
            </Button>
          </section>
        )}

        {canResetPassword && (
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('admin.users.resetPassword')}
            </h3>
            <Input
              label={t('admin.users.newPassword')}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <Button
              size="sm"
              onClick={resetPassword}
              loading={busy === 'password'}
              disabled={!newPassword}
              className="self-start"
            >
              {t('admin.users.resetPassword')}
            </Button>
          </section>
        )}

        {canDeactivate && user.isActive && (
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeactivateOpen(true)}
              className="self-start"
            >
              {t('admin.users.deactivate')}
            </Button>
          </section>
        )}
      </div>

      {deactivateOpen && (
        <Modal
          open
          onClose={() => setDeactivateOpen(false)}
          title={t('admin.users.deactivateTitle')}
          description={t('admin.users.deactivateDescription', { name: user.name })}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeactivateOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={deactivate} loading={busy === 'deactivate'}>
                {t('admin.users.deactivate')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-secondary">
            {t('admin.users.deactivateDescription', { name: user.name })}
          </p>
        </Modal>
      )}
    </Drawer>
  );
}
