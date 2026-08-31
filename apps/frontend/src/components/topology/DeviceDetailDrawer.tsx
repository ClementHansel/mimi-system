'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Save, Unlink, Archive } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Drawer, StatusBadge, Input, Select, Button, Modal, toast } from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import { DeviceCategory } from '@/lib/shared-types';
import type { TopologyDevice, TopologyLocation } from './lib/types';
import { updateDevice, unpairDevice, retireDevice } from './lib/device-api';
import { errMsg } from '@/lib/api-error';

/**
 * Per-device detail (ticket: "last seen, app version, queue depth, and
 * whether it is paired to a branch node"). The tree endpoint doesn't carry a
 * per-device `nodeId` (only `TopologyLocation.node`), so "paired to a
 * branch node" is read at the outlet level — every device under an outlet
 * with a live node routes LAN-first through it; see `lib/rollup.ts` and the
 * report note on this endpoint-shape gap.
 *
 * Storage is deliberately NOT rendered here — CONTRACTS heartbeat payload
 * ships `storage.usedMb/quotaMb` as a hardcoded `0/0` stub today, so showing
 * it would read as "every tablet has 0 MB used", which is wrong, not just
 * unhelpful. `topology.device.storageNote` explains the omission instead of
 * silently dropping the field.
 *
 * Owner (2026-08-27): "there is no way to add devices and settings network
 * etc." — the management half of that gap. `PATCH /devices/:id` (rename /
 * recategorise / move location) and `POST /devices/:id/{unpair,retire}` are
 * gated on `device.manage` here, matching `devices.controller.ts`'s own
 * `@RequirePermission('device.manage')` on all three — a role that cannot
 * `can('device.manage')` never sees the section at all, rather than seeing
 * disabled controls for a call the server would 403 anyway.
 */
export function DeviceDetailDrawer({
  device,
  location,
  locations,
  onClose,
  onChanged,
}: {
  device: TopologyDevice | null;
  location: TopologyLocation;
  /** Every location in the tree, for the "move to" picker — see `lib/rollup.ts#flattenTopologyLocations`. */
  locations: { id: string; name: string }[];
  onClose: () => void;
  /** Called after any successful rename/recategorise/move/unpair/retire so the caller re-fetches the tree. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();

  return (
    <Drawer
      open={!!device}
      onClose={onClose}
      title={device ? device.name : t('topology.device.detailTitle')}
      side="right"
      size="sm"
    >
      {device && (
        <div className="flex flex-col gap-4">
          <dl className="flex flex-col gap-4 text-sm">
            <Row label={t('common.status')}>
              <StatusBadge domain="device" status={device.status} />
            </Row>
            <Row label={t('topology.device.columnCategory')}>
              {t(`topology.device.category.${device.category}`)}
            </Row>
            <Row label={t('topology.device.lastSeen')}>{fmtDateTime(device.lastSeenAt)}</Row>
            <Row label={t('topology.device.appVersion')}>{device.appVersion ?? '—'}</Row>
            <Row label={t('topology.device.queueDepth')}>{device.queueDepth}</Row>
            <Row label={t('topology.device.ipAddress')}>{device.ipAddress ?? '—'}</Row>
            <Row label={t('topology.device.pairedToNode')}>
              {location.node
                ? t('topology.device.pairedToNodeYes', { name: location.node.name })
                : t('topology.device.pairedToNodeNo')}
            </Row>
            <p className="rounded-md bg-surface-sunken p-3 text-xs text-text-muted">
              {t('topology.device.storageNote')}
            </p>
          </dl>

          {can('device.manage') && (
            <DeviceManageSection
              device={device}
              location={location}
              locations={locations}
              onChanged={onChanged}
              onClose={onClose}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}

function DeviceManageSection({
  device,
  location,
  locations,
  onChanged,
  onClose,
}: {
  device: TopologyDevice;
  location: TopologyLocation;
  locations: { id: string; name: string }[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(device.name);
  const [category, setCategory] = useState<string>(device.category);
  const [locationId, setLocationId] = useState(location.location.id);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [unpairOpen, setUnpairOpen] = useState(false);
  const [unpairReason, setUnpairReason] = useState('');
  const [unpairBusy, setUnpairBusy] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);

  const [retireOpen, setRetireOpen] = useState(false);
  const [retireBusy, setRetireBusy] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

  // Re-seed whenever a different device is opened.
  useEffect(() => {
    setName(device.name);
    setCategory(device.category);
    setLocationId(location.location.id);
    setSaveError(null);
  }, [device.id, device.name, device.category, location.location.id]);

  const isRetired = device.status === 'retired';
  const isUnpaired = device.status === 'unpaired';
  const dirty =
    name !== device.name || category !== device.category || locationId !== location.location.id;

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await updateDevice(device.id, { name, category, locationId });
      toast({ title: t('topology.device.manage.saved'), variant: 'success' });
      onChanged();
    } catch (err) {
      setSaveError(errMsg(err, t('topology.device.manage.saveError')));
    } finally {
      setSaving(false);
    }
  }

  async function confirmUnpair() {
    setUnpairBusy(true);
    setUnpairError(null);
    try {
      await unpairDevice(device.id, unpairReason || undefined);
      toast({ title: t('topology.device.manage.unpairSuccess'), variant: 'success' });
      setUnpairOpen(false);
      onChanged();
      onClose();
    } catch (err) {
      setUnpairError(errMsg(err, t('topology.device.manage.unpairError')));
    } finally {
      setUnpairBusy(false);
    }
  }

  async function confirmRetire() {
    setRetireBusy(true);
    setRetireError(null);
    try {
      await retireDevice(device.id);
      toast({ title: t('topology.device.manage.retireSuccess'), variant: 'success' });
      setRetireOpen(false);
      onChanged();
      onClose();
    } catch (err) {
      setRetireError(errMsg(err, t('topology.device.manage.retireError')));
    } finally {
      setRetireBusy(false);
    }
  }

  if (isRetired) {
    return (
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t('topology.device.manage.title')}
        </h3>
        <p className="text-xs text-text-muted">{t('topology.device.manage.disabledRetired')}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-text-primary">
        {t('topology.device.manage.title')}
      </h3>
      {isUnpaired && (
        <p className="text-xs text-warning-700">{t('topology.device.manage.disabledUnpaired')}</p>
      )}

      <Input
        label={t('topology.device.manage.nameLabel')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Select
        label={t('topology.device.manage.categoryLabel')}
        value={category}
        onValueChange={setCategory}
        options={Object.values(DeviceCategory).map((c) => ({
          value: c,
          label: t(`topology.device.category.${c}`),
        }))}
      />
      <Select
        label={t('topology.device.manage.locationLabel')}
        value={locationId}
        onValueChange={setLocationId}
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />
      {saveError && <p className="text-sm text-danger-600">{saveError}</p>}
      <Button
        size="sm"
        onClick={save}
        loading={saving}
        disabled={!dirty || !name.trim()}
        leftIcon={<Save className="size-4" />}
        className="self-start"
      >
        {t('topology.device.manage.save')}
      </Button>

      <div className="flex flex-wrap gap-2 pt-2">
        {!isUnpaired && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUnpairOpen(true)}
            leftIcon={<Unlink className="size-4" />}
          >
            {t('topology.device.manage.unpair')}
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          onClick={() => setRetireOpen(true)}
          leftIcon={<Archive className="size-4" />}
        >
          {t('topology.device.manage.retire')}
        </Button>
      </div>

      {unpairOpen && (
        <Modal
          open
          onClose={() => setUnpairOpen(false)}
          title={t('topology.device.manage.unpairTitle')}
          description={t('topology.device.manage.unpairDescription', { name: device.name })}
          footer={
            <>
              <Button variant="outline" onClick={() => setUnpairOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={confirmUnpair} loading={unpairBusy}>
                {t('topology.device.manage.unpairConfirm')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Input
              label={t('topology.device.manage.unpairReason')}
              value={unpairReason}
              onChange={(e) => setUnpairReason(e.target.value)}
            />
            {unpairError && <p className="text-sm text-danger-600">{unpairError}</p>}
          </div>
        </Modal>
      )}

      {retireOpen && (
        <Modal
          open
          onClose={() => setRetireOpen(false)}
          title={t('topology.device.manage.retireTitle')}
          description={t('topology.device.manage.retireDescription', { name: device.name })}
          footer={
            <>
              <Button variant="outline" onClick={() => setRetireOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={confirmRetire} loading={retireBusy}>
                {t('topology.device.manage.retireConfirm')}
              </Button>
            </>
          }
        >
          {retireError && <p className="text-sm text-danger-600">{retireError}</p>}
        </Modal>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </div>
  );
}
