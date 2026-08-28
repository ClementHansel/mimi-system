'use client';

import { useEffect, useState } from 'react';
import { ERR_NODE_SHIFT_OPEN } from '@mimi/shared';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { ApiError } from '@/lib/api';
import { Modal, Button, StatusBadge, Input, toast } from '@/components/ui';
import { fmtTime, fmtDateTime } from '@/lib/dates';
import type { TopologyLocation } from './lib/types';
import {
  setOutletNodeEnabled,
  mintNodePairingToken,
  getNodeDetail,
  setNodeNetworkConfig,
  sendNodeCommand,
  type NodeDetail,
} from './lib/node-api';
import type { MintedPairingToken } from './lib/device-api';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function errCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

function msRemaining(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}

function fmtCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The one "network setting" this ticket found real backing for (see the
 * report note on `lib/node-api.ts`): whether this outlet runs a branch node
 * at all (D-26, Owner-only, drain-before-off), and — once on — pairing the
 * physical PC that becomes it.
 *
 * Opened from `OutletCard`'s node indicator. Not from `DeviceDetailDrawer`:
 * a branch node is not a `devices` row (it lives in `branch_nodes`, a
 * different table with different lifecycle rules — see D-26's drain
 * guarantee), so it gets its own small modal rather than being force-fit
 * into the device drawer.
 */
export function NodeSettingModal({
  location,
  onClose,
  onChanged,
}: {
  location: TopologyLocation;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { can, roleKey } = usePermissions();
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintResult, setMintResult] = useState<MintedPairingToken | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const nodeId = location.node?.id;
  const [detail, setDetail] = useState<NodeDetail | null>(null);

  // Network config form (W3-10) — only the two fields this node build genuinely applies; see
  // `lib/node-api.ts`'s doc comment for why WiFi/static-IP are not offered here.
  const [healthPortInput, setHealthPortInput] = useState('');
  const [scanSubnetInput, setScanSubnetInput] = useState('');
  const [netBusy, setNetBusy] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);

  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [restartShiftOpen, setRestartShiftOpen] = useState(false);

  const [logPullBusy, setLogPullBusy] = useState(false);
  const [logPullError, setLogPullError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logPullCommandId, setLogPullCommandId] = useState<string | null>(null);

  useEffect(() => {
    if (!mintResult) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mintResult]);
  void now;

  // Fresh, polled node detail (isConnected, networkConfigStatus, recent events) — the topology
  // tree's cached `location.node` is not fine-grained enough for apply-then-confirm to feel live.
  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    async function load() {
      try {
        const d = await getNodeDetail(nodeId!);
        if (!cancelled) setDetail(d);
      } catch {
        // Silent — this is a background refresh; the modal still functions on the last-known detail.
      }
    }
    void load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nodeId]);

  // While a log_pull is outstanding, refresh more often than the general 3s poll above so the result
  // shows up promptly once `BridgeGateway.onLogsChunk` persists it (a `command_result` device_event).
  useEffect(() => {
    if (!logPullCommandId || !nodeId) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const d = await getNodeDetail(nodeId!);
        if (!cancelled) setDetail(d);
      } catch {
        // Silent — same background-refresh stance as the general poll above.
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [logPullCommandId, nodeId]);

  // Extracts a completed log_pull's lines from `detail.events` (BridgeGateway.onLogsChunk persists it
  // as a `command_result` device_event once the node's stream finishes — see that file's doc comment).
  useEffect(() => {
    if (!logPullCommandId || !detail) return;
    const match = detail.events.find(
      (e) =>
        e.type === 'command_result' &&
        (e.detail as { commandId?: string; kind?: string })?.commandId === logPullCommandId &&
        (e.detail as { kind?: string })?.kind === 'log_pull',
    );
    if (match) {
      setLogLines((match.detail as { lines?: string[] }).lines ?? []);
      setLogPullCommandId(null);
    }
  }, [detail, logPullCommandId]);

  // D-26: the toggle itself is Owner-only server-side, on top of `node.manage` —
  // see `lib/node-api.ts`'s doc comment. Mirrored here, not just `can('node.manage')`.
  const canToggle = roleKey === 'owner';
  const canPair = can('node.manage');

  async function toggle(nextEnabled: boolean) {
    setToggleBusy(true);
    setToggleError(null);
    try {
      await setOutletNodeEnabled(location.location.id, nextEnabled);
      onChanged();
    } catch (err) {
      setToggleError(errMsg(err, t('topology.nodeSetting.toggleError')));
    } finally {
      setToggleBusy(false);
    }
  }

  async function mint() {
    setMinting(true);
    setMintError(null);
    try {
      const minted = await mintNodePairingToken(location.location.id);
      setMintResult(minted);
      setNow(Date.now());
    } catch (err) {
      setMintError(errMsg(err, t('topology.nodeSetting.mintError')));
    } finally {
      setMinting(false);
    }
  }

  async function saveNetworkConfig() {
    if (!nodeId) return;
    const patch: { healthPort?: number; scanSubnet?: string | null } = {};
    if (healthPortInput.trim() !== '') {
      const n = Number(healthPortInput);
      if (!Number.isInteger(n)) {
        setNetError(t('topology.nodeSetting.network.invalidPort'));
        return;
      }
      patch.healthPort = n;
    }
    if (scanSubnetInput.trim() !== '') {
      patch.scanSubnet = scanSubnetInput.trim();
    }
    if (patch.healthPort === undefined && patch.scanSubnet === undefined) {
      setNetError(t('topology.nodeSetting.network.emptyPatch'));
      return;
    }

    setNetBusy(true);
    setNetError(null);
    try {
      await setNodeNetworkConfig(nodeId, patch);
      toast({ title: t('topology.nodeSetting.network.pushed'), variant: 'success' });
      setHealthPortInput('');
      setScanSubnetInput('');
      const d = await getNodeDetail(nodeId);
      setDetail(d);
    } catch (err) {
      setNetError(errMsg(err, t('topology.nodeSetting.network.error')));
    } finally {
      setNetBusy(false);
    }
  }

  async function restart(override: boolean) {
    if (!nodeId) return;
    setRestartBusy(true);
    setRestartError(null);
    try {
      await sendNodeCommand(nodeId, 'restart', override ? { override: true } : undefined);
      setRestartShiftOpen(false);
      toast({ title: t('topology.nodeSetting.commands.restartSent'), variant: 'success' });
    } catch (err) {
      if (errCode(err) === ERR_NODE_SHIFT_OPEN) {
        setRestartShiftOpen(true);
        setRestartError(errMsg(err, t('topology.nodeSetting.commands.restartShiftOpen')));
      } else {
        setRestartError(errMsg(err, t('topology.nodeSetting.commands.restartError')));
      }
    } finally {
      setRestartBusy(false);
    }
  }

  async function pullLogs() {
    if (!nodeId) return;
    setLogPullBusy(true);
    setLogPullError(null);
    setLogLines(null);
    try {
      const sent = await sendNodeCommand(nodeId, 'log_pull', { lines: 200 });
      setLogPullCommandId(sent.commandId);
    } catch (err) {
      setLogPullError(errMsg(err, t('topology.nodeSetting.commands.logPullError')));
    } finally {
      setLogPullBusy(false);
    }
  }

  const liveRemaining = mintResult ? msRemaining(mintResult.expiresAt) : 0;
  const expired = !!mintResult && liveRemaining <= 0;
  const networkFieldResults = detail?.networkConfigResult.fields ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      title={t('topology.nodeSetting.title', { name: location.location.name })}
      description={t('topology.nodeSetting.description')}
      footer={
        <Button variant="outline" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-muted">{t('topology.nodeSetting.currentState')}:</span>
          {location.nodeEnabled ? (
            <StatusBadge domain="topologyOutlet" status="online" size="sm" />
          ) : (
            <span className="text-text-secondary">{t('topology.outlet.node.none')}</span>
          )}
          {location.node && (
            <>
              <span className="text-text-muted">·</span>
              <StatusBadge domain="device" status={location.node.status} size="sm" />
              <span className="text-xs text-text-muted">
                {t('topology.nodeSetting.pairedAt', {
                  when: fmtDateTime(location.node.lastSeenAt),
                })}
              </span>
            </>
          )}
        </div>

        {!canToggle && (
          <p className="text-xs text-text-muted">{t('topology.nodeSetting.ownerOnly')}</p>
        )}

        {canToggle && (
          <div className="flex flex-col gap-2">
            {!location.nodeEnabled ? (
              <Button
                size="sm"
                onClick={() => toggle(true)}
                loading={toggleBusy}
                className="self-start"
              >
                {t('topology.nodeSetting.enable')}
              </Button>
            ) : (
              <>
                <p className="text-xs text-text-muted">{t('topology.nodeSetting.disableHint')}</p>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => toggle(false)}
                  loading={toggleBusy}
                  className="self-start"
                >
                  {t('topology.nodeSetting.disable')}
                </Button>
              </>
            )}
            {toggleError && <p className="text-sm text-danger-600">{toggleError}</p>}
          </div>
        )}

        {location.nodeEnabled && !location.node && canPair && (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                {t('topology.nodeSetting.pairTitle')}
              </h3>
              <p className="text-xs text-text-muted">{t('topology.nodeSetting.pairHint')}</p>
            </div>

            {!mintResult && (
              <Button size="sm" onClick={mint} loading={minting} className="self-start">
                {t('topology.nodeSetting.mint')}
              </Button>
            )}
            {mintError && <p className="text-sm text-danger-600">{mintError}</p>}

            {mintResult && (
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <div
                  className={
                    expired
                      ? 'rounded-lg border border-border bg-surface-sunken px-6 py-4 font-mono text-2xl font-semibold tracking-[0.3em] text-text-muted line-through'
                      : 'rounded-lg border border-brand-200 bg-brand-50 px-6 py-4 font-mono text-2xl font-semibold tracking-[0.3em] text-brand-700'
                  }
                >
                  {mintResult.displayCode}
                </div>
                {expired ? (
                  <p className="text-sm font-medium text-danger-600">
                    {t('topology.addDevice.expired')}
                  </p>
                ) : (
                  <p className="text-sm text-text-secondary">
                    {t('topology.addDevice.expiresIn', {
                      minutes: 15,
                      time: fmtTime(mintResult.expiresAt),
                    })}{' '}
                    <span className="font-mono font-semibold text-text-primary">
                      {fmtCountdown(liveRemaining)}
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {location.node && canPair && (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                {t('topology.nodeSetting.network.title')}
              </h3>
              <p className="text-xs text-text-muted">{t('topology.nodeSetting.network.hint')}</p>
            </div>

            {detail && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-text-muted">{t('topology.nodeSetting.network.status')}:</span>
                <span
                  className={
                    detail.networkConfigStatus === 'applied'
                      ? 'font-medium text-success-600'
                      : detail.networkConfigStatus === 'pending'
                        ? 'font-medium text-warning-600'
                        : detail.networkConfigStatus === 'reverted' ||
                            detail.networkConfigStatus === 'failed'
                          ? 'font-medium text-danger-600'
                          : 'text-text-secondary'
                  }
                >
                  {t(`topology.nodeSetting.network.statusValue.${detail.networkConfigStatus}`)}
                </span>
                {detail.networkConfig.healthPort !== undefined && (
                  <span className="text-text-muted">
                    ·{' '}
                    {t('topology.nodeSetting.network.currentPort', {
                      port: detail.networkConfig.healthPort,
                    })}
                  </span>
                )}
                {!detail.isConnected && (
                  <span className="text-danger-600">
                    {t('topology.nodeSetting.network.disconnectedWarning')}
                  </span>
                )}
              </div>
            )}
            {networkFieldResults.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-xs text-text-muted">
                {networkFieldResults.map((f) => (
                  <li key={f.field}>
                    {f.field}: {f.applied ? t('common.yes') : t('common.no')} ({f.reason})
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <Input
                label={t('topology.nodeSetting.network.healthPort')}
                type="number"
                size="sm"
                value={healthPortInput}
                onChange={(e) => setHealthPortInput(e.target.value)}
                placeholder={String(detail?.networkConfig.healthPort ?? '')}
                wrapperClassName="w-32"
              />
              <Input
                label={t('topology.nodeSetting.network.scanSubnet')}
                size="sm"
                value={scanSubnetInput}
                onChange={(e) => setScanSubnetInput(e.target.value)}
                placeholder={detail?.networkConfig.scanSubnet ?? '192.168.1.0/24'}
                wrapperClassName="w-44"
              />
              <Button
                size="sm"
                onClick={saveNetworkConfig}
                loading={netBusy}
                disabled={!detail?.isConnected}
              >
                {t('topology.nodeSetting.network.save')}
              </Button>
            </div>
            {netError && <p className="text-sm text-danger-600">{netError}</p>}
          </div>
        )}

        {location.node && canPair && (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                {t('topology.nodeSetting.commands.title')}
              </h3>
              <p className="text-xs text-text-muted">{t('topology.nodeSetting.commands.hint')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                onClick={() => restart(false)}
                loading={restartBusy}
                disabled={!detail?.isConnected}
              >
                {t('topology.nodeSetting.commands.restart')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={pullLogs}
                loading={logPullBusy}
                disabled={!detail?.isConnected}
              >
                {t('topology.nodeSetting.commands.pullLogs')}
              </Button>
            </div>
            {restartError && <p className="text-sm text-danger-600">{restartError}</p>}
            {restartShiftOpen && (
              <div className="flex flex-col gap-2 rounded-md border border-warning-200 bg-warning-50 p-2">
                <p className="text-xs text-warning-700">
                  {t('topology.nodeSetting.commands.restartShiftOpenHint')}
                </p>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => restart(true)}
                  loading={restartBusy}
                  className="self-start"
                >
                  {t('topology.nodeSetting.commands.restartOverride')}
                </Button>
              </div>
            )}

            {logPullError && <p className="text-sm text-danger-600">{logPullError}</p>}
            {logPullCommandId && logLines === null && (
              <p className="text-xs text-text-muted">
                {t('topology.nodeSetting.commands.logPullWaiting')}
              </p>
            )}
            {logLines !== null && (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-text-muted">
                  {t('topology.nodeSetting.commands.logPullResult', { count: logLines.length })}
                </p>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-surface-sunken p-2 text-[11px] leading-4 text-text-secondary">
                  {logLines.length > 0
                    ? logLines.join('\n')
                    : t('topology.nodeSetting.commands.logPullEmpty')}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
