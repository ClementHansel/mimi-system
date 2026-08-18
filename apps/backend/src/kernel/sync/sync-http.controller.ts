/**
 * `/sync/v1/*` — SYNC-PROTOCOL §4.1's HTTP fallback (same JSON bodies as the
 * `/sync` socket namespace, `sync.gateway.ts`). Device-token authenticated
 * (`DeviceAuthGuard`), `@Public()` so the global user-JWT guard chain
 * (`JwtAuthGuard`/`RlsContextGuard`) never runs for these routes.
 *
 * `PUT /sync/v1/attachments/:sha256` (§4.7) is NOT implemented here: it
 * needs `StorageService` (kernel/storage, W2-C — MinIO presigned upload),
 * which is still an empty stub. Wiring that endpoint once `StorageService`
 * exists is a follow-up, flagged in the W2-D report — better an honest gap
 * than a half-built binary store.
 */
import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { Public } from '../../common/decorators/public.decorator';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { SyncHelloRequest } from '@mimi/sync-protocol';
import { DeviceAuthGuard, type RequestWithDevice } from './device-auth.guard';
import { RegistryRepository } from './registry.repository';
import { SyncIngestService } from './sync-ingest.service';
import { SyncPullService } from './sync-pull.service';
import { MAX_PULL_LIMIT } from './constants';
import { withSystemContext } from './system-rls-context';
import { decodeWireBatch, encodePullResult, type WireSyncPushBatch } from './wire-codec';

const PROTOCOL_V = 1;

@Controller('sync/v1')
export class SyncHttpController {
  constructor(
    private readonly ingest: SyncIngestService,
    private readonly pull: SyncPullService,
    private readonly registry: RegistryRepository,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      ok: true,
      protocol_v: PROTOCOL_V,
      server_time: new Date().toISOString(),
      tier: 'cloud' as const,
    };
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('hello')
  async hello(@Req() req: RequestWithDevice, @Body() body: SyncHelloRequest) {
    const device = req.device!;
    const ack = await this.pull.hello(
      {
        subscriberId: device.id,
        subscriberTier: 'device',
        locationIds: [device.locationId],
        projectionRole: 'pos_device',
      },
      body.pullCursor ?? 0,
      body.outboxDepth ?? 0,
    );
    await withSystemContext(this.pool, (client) =>
      this.registry.touchDeviceSync(client, device.id, body.outboxDepth ?? 0),
    );
    return ack;
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('push')
  async push(@Req() req: RequestWithDevice, @Body() wireBody: WireSyncPushBatch) {
    const body = decodeWireBatch(wireBody); // client_seq: wire decimal string -> internal bigint (wire-codec.ts)
    const device = req.device!;
    // Security posture (documented limitation, see W2-D report): this V1 endpoint accepts ONLY the
    // authenticated device's own origin — a multi-origin batch (node relay, once M22 exists) is out of
    // scope here; any event claiming a different origin is rejected outright rather than silently trusted.
    const foreign = body.events.find((e) => e.originDeviceId !== device.id);
    if (foreign) {
      return {
        batchId: body.batchId,
        acceptedThrough: {},
        confirmedThrough: {},
        rejected: body.events.map((e) => ({
          eventId: e.eventId,
          code: 'malformed',
          detail:
            'batch contains an origin_device_id other than the authenticated device (node relay not yet supported)',
        })),
      };
    }

    return this.ingest.ingestBatch(body, async (originDeviceId) => {
      if (originDeviceId !== device.id) return undefined;
      return device.locationId;
    });
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Get('pull')
  async pullEvents(
    @Req() req: RequestWithDevice,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const device = req.device!;
    const scope = this.pull.buildScope({
      subscriberId: device.id,
      subscriberTier: 'device',
      locationIds: [device.locationId],
      projectionRole: 'pos_device',
    });
    const result = await this.pull.pull(
      scope,
      Number(cursor ?? 0),
      Math.min(Number(limit ?? MAX_PULL_LIMIT), MAX_PULL_LIMIT),
    );
    return encodePullResult(result); // client_seq: internal bigint -> wire decimal string (wire-codec.ts)
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('bootstrap')
  async bootstrap(@Req() req: RequestWithDevice) {
    const device = req.device!;
    const scope = this.pull.buildScope({
      subscriberId: device.id,
      subscriberTier: 'device',
      locationIds: [device.locationId],
      projectionRole: 'pos_device',
    });
    const startingCursor = await this.pull.bootstrapStartingCursor();
    const page = await this.pull.pull(scope, 0, MAX_PULL_LIMIT);
    return { ...encodePullResult(page), startingCursor };
  }
}
