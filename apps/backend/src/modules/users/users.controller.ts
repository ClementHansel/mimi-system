/** M02 `users` — CONTRACTS.md §4.2. */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Paginated, UserRow } from '@mimi/shared';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { UsersService } from './users.service';
import {
  AssignLocationsDto,
  AssignRoleDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetPasswordDto,
  UpdateUserDto,
} from './users.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  @RequirePermission('user.read')
  list(@Query() query: ListUsersQueryDto, @Req() req: RequestWithDbContext): Promise<Paginated<UserRow>> {
    return this.service.list(query, req.dbClient!);
  }

  @Get(':id')
  @RequirePermission('user.read')
  getOne(@Param('id') id: string, @Req() req: RequestWithDbContext): Promise<UserRow> {
    return this.service.getOne(id, req.dbClient!);
  }

  @Post()
  @RequirePermission('user.create')
  @Audited({ entityType: 'users', action: 'user.create' })
  create(@Body() dto: CreateUserDto, @CurrentUser() caller: JwtAccessPayload, @Req() req: RequestWithDbContext): Promise<UserRow> {
    return this.service.create(dto, caller, req.dbClient!);
  }

  @Patch(':id')
  @RequirePermission('user.update')
  @Audited({ entityType: 'users', action: 'user.update' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() caller: JwtAccessPayload, @Req() req: RequestWithDbContext): Promise<UserRow> {
    return this.service.update(id, dto, caller, req.dbClient!);
  }

  @Put(':id/role')
  @RequirePermission('user.role.assign')
  @Audited({ entityType: 'users', action: 'user.role.assign' })
  assignRole(@Param('id') id: string, @Body() dto: AssignRoleDto, @CurrentUser() caller: JwtAccessPayload, @Req() req: RequestWithDbContext): Promise<UserRow> {
    return this.service.assignRole(id, dto, caller, req.dbClient!);
  }

  @Put(':id/locations')
  @RequirePermission('user.location.assign')
  @Audited({ entityType: 'users', action: 'user.location.assign' })
  assignLocations(@Param('id') id: string, @Body() dto: AssignLocationsDto, @CurrentUser() caller: JwtAccessPayload, @Req() req: RequestWithDbContext): Promise<UserRow> {
    return this.service.assignLocations(id, dto, caller, req.dbClient!);
  }

  @Post(':id/reset-password')
  @RequirePermission('user.password.reset')
  @Audited({ entityType: 'users', action: 'user.password.reset' })
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @Req() req: RequestWithDbContext): Promise<{ ok: true }> {
    return this.service.resetPassword(id, dto, req.dbClient!);
  }

  @Delete(':id')
  @RequirePermission('user.deactivate')
  @Audited({ entityType: 'users', action: 'user.deactivate' })
  deactivate(@Param('id') id: string, @CurrentUser() caller: JwtAccessPayload, @Req() req: RequestWithDbContext): Promise<{ id: string; deactivated: true }> {
    return this.service.deactivate(id, caller, req.dbClient!);
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly service: UsersService) {}

  @Get()
  @RequirePermission('user.read')
  list(@Req() req: RequestWithDbContext): Promise<{ key: string; name: string; permissions: string[] }[]> {
    return this.service.listRoles(req.dbClient!);
  }
}
