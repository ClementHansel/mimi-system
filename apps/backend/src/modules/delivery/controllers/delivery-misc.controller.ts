import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../../common/decorators';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';
import { requireDbClient } from '../request-db-client';
import { SuratJalanService } from '../services/surat-jalan.service';
import { DriverVehicleService } from '../services/driver-vehicle.service';
import { RecapService } from '../services/recap.service';
import { ColdChainService } from '../services/cold-chain.service';
import { GoodsReceiptService } from '../services/goods-receipt.service';
import { CreateTemperatureLogDto } from '../dto/drop.dto';
import { ListActiveQueryDto, CreateDriverDto, UpdateDriverDto, CreateVehicleDto, UpdateVehicleDto } from '../dto/driver-vehicle.dto';
import { CreateGoodsReceiptDto } from '../dto/goods-receipt.dto';

/** M10 `delivery` — temperature logs, driver's jobs, daily recap, drivers/vehicles master data, goods receipts (CONTRACTS.md §4.10). */
@Controller('delivery')
export class DeliveryMiscController {
  constructor(
    private readonly sj: SuratJalanService,
    private readonly driversVehicles: DriverVehicleService,
    private readonly recap: RecapService,
    private readonly coldChain: ColdChainService,
    private readonly goodsReceipts: GoodsReceiptService,
  ) {}

  @Post('temperature-logs')
  @RequirePermission('delivery.drop.execute')
  @Audited({ entityType: 'sj_temperature_log', action: 'delivery.drop.execute' })
  createTemperatureLog(@Req() req: Request, @Body() dto: CreateTemperatureLogDto, @CurrentUser() user: JwtAccessPayload) {
    return this.coldChain.recordStandalone(
      requireDbClient(req),
      { sjId: dto.sjId, dropId: dto.dropId ?? null, stage: dto.stage, tempC: dto.tempC },
      user.sub,
    );
  }

  @Get('my-jobs')
  @RequirePermission('delivery.drop.execute')
  myJobs(@Req() req: Request, @CurrentUser() user: JwtAccessPayload, @Query('date') date?: string) {
    return this.sj.myJobs(requireDbClient(req), user.sub, date);
  }

  @Get('recap/daily')
  @RequirePermission('report.logistics.read')
  dailyRecap(@Req() req: Request, @Query('date') date: string) {
    return this.recap.dailyRecap(requireDbClient(req), date);
  }

  @Get('drivers')
  @RequirePermission('delivery.read')
  listDrivers(@Req() req: Request, @Query() query: ListActiveQueryDto) {
    return this.driversVehicles.listDrivers(requireDbClient(req), query.active);
  }

  @Post('drivers')
  @RequirePermission('delivery.master.manage')
  @Audited({ entityType: 'drivers', action: 'delivery.master.manage' })
  @HttpCode(HttpStatus.CREATED)
  createDriver(@Req() req: Request, @Body() dto: CreateDriverDto, @CurrentUser() user: JwtAccessPayload) {
    return this.driversVehicles.createDriver(requireDbClient(req), dto, user.sub);
  }

  @Patch('drivers/:id')
  @RequirePermission('delivery.master.manage')
  @Audited({ entityType: 'drivers', action: 'delivery.master.manage' })
  updateDriver(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateDriverDto, @CurrentUser() user: JwtAccessPayload) {
    return this.driversVehicles.updateDriver(requireDbClient(req), id, dto, user.sub);
  }

  @Get('vehicles')
  @RequirePermission('delivery.read')
  listVehicles(@Req() req: Request, @Query() query: ListActiveQueryDto) {
    return this.driversVehicles.listVehicles(requireDbClient(req), query.active);
  }

  @Post('vehicles')
  @RequirePermission('delivery.master.manage')
  @Audited({ entityType: 'vehicles', action: 'delivery.master.manage' })
  @HttpCode(HttpStatus.CREATED)
  createVehicle(@Req() req: Request, @Body() dto: CreateVehicleDto, @CurrentUser() user: JwtAccessPayload) {
    return this.driversVehicles.createVehicle(requireDbClient(req), dto, user.sub);
  }

  @Patch('vehicles/:id')
  @RequirePermission('delivery.master.manage')
  @Audited({ entityType: 'vehicles', action: 'delivery.master.manage' })
  updateVehicle(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateVehicleDto, @CurrentUser() user: JwtAccessPayload) {
    return this.driversVehicles.updateVehicle(requireDbClient(req), id, dto, user.sub);
  }

  /**
   * `POST /api/delivery/goods-receipts` — NOT in CONTRACTS.md §4.10's literal
   * table; see `dto/goods-receipt.dto.ts`'s header for why this endpoint
   * exists (supplier-direct receiving, PRD 8.6.1, and blind/unmatched
   * deliveries, SYNC-PROTOCOL §8 row 6). Gated the same as drop receiving.
   */
  @Post('goods-receipts')
  @RequirePermission('delivery.receive')
  @Audited({ entityType: 'goods_receipts', action: 'delivery.receive' })
  @HttpCode(HttpStatus.CREATED)
  createGoodsReceipt(@Req() req: Request, @Body() dto: CreateGoodsReceiptDto, @CurrentUser() user: JwtAccessPayload) {
    return this.goodsReceipts.create(requireDbClient(req), dto, user.sub);
  }
}
