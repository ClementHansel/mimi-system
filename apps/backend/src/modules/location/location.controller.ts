import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient } from './request-db-client';
import { LocationService } from './location.service';
import { StorageAreaService } from './storage-area.service';
import { CreateLocationDto, ListLocationsQueryDto, UpdateLocationDto } from './dto/location.dto';
import {
  CreateStorageAreaDto,
  ListStorageAreasQueryDto,
  UpdateStorageAreaDto,
} from './dto/storage-area.dto';

/** M03 `location` — CONTRACTS.md §4.3 (outlets, gudang pusat, storage areas D-15). */
@Controller('locations')
export class LocationController {
  constructor(
    private readonly locations: LocationService,
    private readonly storageAreas: StorageAreaService,
  ) {}

  @Get()
  @RequirePermission('location.read')
  list(@Req() req: Request, @Query() query: ListLocationsQueryDto) {
    return this.locations.list(requireDbClient(req), query);
  }

  @Get('cities')
  @RequirePermission('location.read')
  cities(@Req() req: Request) {
    return this.locations.listCities(requireDbClient(req));
  }

  @Get(':id')
  @RequirePermission('location.read')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.locations.getById(requireDbClient(req), id);
  }

  @Post()
  @RequirePermission('location.manage')
  @Audited({ entityType: 'location', action: 'location.manage' })
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() req: Request,
    @Body() dto: CreateLocationDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.locations.create(requireDbClient(req), dto, user.sub);
  }

  @Patch(':id')
  @RequirePermission('location.manage')
  @Audited({ entityType: 'location', action: 'location.manage' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.locations.update(requireDbClient(req), id, dto, user.sub);
  }

  @Delete(':id')
  @RequirePermission('location.manage')
  @Audited({ entityType: 'location', action: 'location.manage' })
  deactivate(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.locations.deactivate(requireDbClient(req), id, user.sub);
  }

  @Get(':id/storage-areas')
  @RequirePermission('location.read')
  listStorageAreas(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: ListStorageAreasQueryDto,
  ) {
    return this.storageAreas.listForLocation(requireDbClient(req), id, query.active);
  }

  @Post(':id/storage-areas')
  @RequirePermission('storage_area.manage')
  @Audited({ entityType: 'storage_area', action: 'storage_area.manage' })
  @HttpCode(HttpStatus.CREATED)
  createStorageArea(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CreateStorageAreaDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.storageAreas.create(requireDbClient(req), id, dto, user.sub);
  }

  @Patch(':id/storage-areas/:areaId')
  @RequirePermission('storage_area.manage')
  @Audited({ entityType: 'storage_area', action: 'storage_area.manage' })
  updateStorageArea(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('areaId') areaId: string,
    @Body() dto: UpdateStorageAreaDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.storageAreas.update(requireDbClient(req), id, areaId, dto, user.sub);
  }

  @Delete(':id/storage-areas/:areaId')
  @RequirePermission('storage_area.manage')
  @Audited({ entityType: 'storage_area', action: 'storage_area.manage' })
  deactivateStorageArea(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('areaId') areaId: string,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.storageAreas.deactivate(requireDbClient(req), id, areaId, user.sub);
  }
}
