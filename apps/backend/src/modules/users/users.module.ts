import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { RolesController, UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';

/**
 * M02 `users` — owned by Wave 3, agent W3-01 (senior-be).
 *
 * User CRUD, role + location assignment (CONTRACTS.md §4.2). Writes to
 * `users`/`user_locations` are `ROLE(owner,manager)`-only per the RLS matrix
 * (§1.14) — `PermissionsGuard` is never the only gate here.
 *
 * `RolesController` (`GET /api/roles`) lives in this module too — CONTRACTS
 * §4.2 places it alongside the users endpoint table and it shares
 * `UsersService`/RBAC helpers; there is no separate `roles` module.
 */
@Module({
  imports: [SyncEngineModule],
  controllers: [UsersController, RolesController],
  providers: [UsersService, UsersRepository],
})
export class UsersModule {}
