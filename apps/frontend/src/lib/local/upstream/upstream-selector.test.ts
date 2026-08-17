import { describe, expect, it } from 'vitest';
import { UpstreamSelector, type UpstreamCandidate } from './upstream-selector';
import type { SyncHealth } from '../transport/types';

function health(ok: boolean): Promise<SyncHealth> {
  return ok
    ? Promise.resolve({ ok: true, protocolV: 1, serverTime: new Date().toISOString(), tier: 'cloud' })
    : Promise.reject(new Error('unhealthy'));
}

describe('UpstreamSelector (SYNC-PROTOCOL §1.3)', () => {
  const node: UpstreamCandidate = { kind: 'node', baseUrl: 'https://node.local' };
  const cloud: UpstreamCandidate = { kind: 'cloud', baseUrl: 'https://cloud.mimi' };

  it('on startup, connects to the first healthy candidate in preference order (node before cloud)', async () => {
    const selector = new UpstreamSelector([node, cloud], async () => health(true), () => 0);
    const state = await selector.tick();
    expect(state.current?.kind).toBe('node');
    expect(state.tier).toBe('lan');
  });

  it('falls through to cloud when the node is unhealthy', async () => {
    const selector = new UpstreamSelector([node, cloud], async (url) => health(url === cloud.baseUrl), () => 0);
    const state = await selector.tick();
    expect(state.current?.kind).toBe('cloud');
    expect(state.tier).toBe('online');
  });

  it('reports "isolated" when no candidate is healthy', async () => {
    const selector = new UpstreamSelector([node, cloud], async () => health(false), () => 0);
    const state = await selector.tick();
    expect(state.current).toBeNull();
    expect(state.tier).toBe('isolated');
  });

  it('does NOT fail away on a single dropped probe (only 3 consecutive failures matter)', async () => {
    let now = 0;
    let nodeHealthy = true;
    const selector = new UpstreamSelector([node, cloud], async (url) => health(url === node.baseUrl ? nodeHealthy : true), () => now);
    await selector.tick(); // selects node

    nodeHealthy = false;
    now += 1000;
    const afterOneFailure = await selector.tick();
    expect(afterOneFailure.current?.kind).toBe('node'); // still on node — a single failure must not switch

    nodeHealthy = true;
    now += 1000;
    const afterRecovery = await selector.tick();
    expect(afterRecovery.current?.kind).toBe('node');
  });

  it('fails away only after 3 consecutive failures spanning >= 10s', async () => {
    let now = 0;
    let nodeHealthy = true;
    const selector = new UpstreamSelector([node, cloud], async (url) => health(url === node.baseUrl ? nodeHealthy : true), () => now);
    await selector.tick(); // node selected

    nodeHealthy = false;
    await selector.tick(); // failure 1 at t=0
    now += 4000;
    await selector.tick(); // failure 2 at t=4000 (span so far: 4s — not enough even at 3 failures)
    now += 4000;
    const stillNode = await selector.tick(); // failure 3 at t=8000 (span: 8s — still under 10s)
    expect(stillNode.current?.kind).toBe('node');

    now += 3000; // span now 11s at failure 4
    const failedAway = await selector.tick();
    expect(failedAway.current?.kind).toBe('cloud');
  });

  it('fails back to the node only after it has been continuously healthy for 60s (not merely healthy once)', async () => {
    let now = 0;
    let nodeHealthy = false;
    const selector = new UpstreamSelector([node, cloud], async (url) => health(url === node.baseUrl ? nodeHealthy : true), () => now);
    await selector.tick(); // node unhealthy -> selects cloud
    expect(selector.getState().current?.kind).toBe('cloud');

    nodeHealthy = true;
    now = 1000; // this tick is node's FIRST healthy sample — starts the continuous-healthy clock at t=1000
    const tooSoon = await selector.tick();
    expect(tooSoon.current?.kind).toBe('cloud');

    now = 1000 + 60_000; // exactly 60s of continuous health since that first sample
    const failedBack = await selector.tick();
    expect(failedBack.current?.kind).toBe('node');
  });

  it('flapping health resets the continuous-healthy timer for fail-back (hysteresis actually prevents flapping)', async () => {
    let now = 0;
    let nodeHealthy = false;
    const selector = new UpstreamSelector([node, cloud], async (url) => health(url === node.baseUrl ? nodeHealthy : true), () => now);
    await selector.tick(); // -> cloud

    nodeHealthy = true;
    now += 30_000;
    await selector.tick(); // 30s healthy so far
    nodeHealthy = false;
    now += 1000;
    await selector.tick(); // drops — resets the healthy-since clock
    nodeHealthy = true;
    now += 30_000;
    const stillCloud = await selector.tick(); // only 30s of CONTINUOUS health since the reset
    expect(stillCloud.current?.kind).toBe('cloud');
  });

  it('works correctly with NO node candidate at all (RISK-P5: node absence never assumed)', async () => {
    const selector = new UpstreamSelector([cloud], async () => health(true), () => 0);
    const state = await selector.tick();
    expect(state.current?.kind).toBe('cloud');
    expect(state.tier).toBe('online');
  });

  it('is exactly one upstream at a time — never both node and cloud simultaneously', async () => {
    const selector = new UpstreamSelector([node, cloud], async () => health(true), () => 0);
    await selector.tick();
    const state = selector.getState();
    expect([state.current?.kind]).not.toContain(undefined);
    expect(state.current === node || state.current === cloud).toBe(true);
  });

  it('notifies onChange listeners only when the selected upstream actually changes', async () => {
    const now = 0;
    const nodeHealthy = true;
    const selector = new UpstreamSelector([node, cloud], async (url) => health(url === node.baseUrl ? nodeHealthy : true), () => now);
    const changes: string[] = [];
    selector.onChange((s) => changes.push(s.tier));

    await selector.tick(); // node selected -> one notification
    await selector.tick(); // still node -> no notification
    expect(changes).toEqual(['lan']);
  });
});
