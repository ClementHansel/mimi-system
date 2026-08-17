import { Body, Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { CreateComponentDto, PutEmployeeComponentsDto, UpdateComponentDto } from '../dto/payroll.dto';
import { ComponentsService } from './components.service';

/** CONTRACTS.md §4.15 — `/api/payroll/components*` and `/api/payroll/employees/:employeeId/components`. */
@Controller('api/payroll')
export class ComponentsController {
  constructor(private readonly service: ComponentsService) {}

  @Get('components')
  @RequirePermission('payroll.read')
  async list(@Req() req: RequestWithDbContext) {
    return this.service.list(req.dbClient!);
  }

  @Post('components')
  @RequirePermission('payroll.component.manage')
  @Audited({ module: 'payroll', entityType: 'salary_components', action: 'payroll.component.manage' })
  async create(@Req() req: RequestWithDbContext, @Body() dto: CreateComponentDto) {
    return this.service.create(req.dbClient!, dto);
  }

  @Patch('components/:id')
  @RequirePermission('payroll.component.manage')
  @Audited({ module: 'payroll', entityType: 'salary_components', action: 'payroll.component.manage' })
  async update(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: UpdateComponentDto) {
    return this.service.update(req.dbClient!, id, dto);
  }

  @Get('employees/:employeeId/components')
  @RequirePermission('payroll.read')
  async listForEmployee(@Req() req: RequestWithDbContext, @Param('employeeId') employeeId: string) {
    return this.service.listForEmployee(req.dbClient!, employeeId);
  }

  @Put('employees/:employeeId/components')
  @RequirePermission('payroll.component.manage')
  @Audited({ module: 'payroll', entityType: 'employee_salary_components', action: 'payroll.component.manage' })
  async putForEmployee(@Req() req: RequestWithDbContext, @Param('employeeId') employeeId: string, @Body() dto: PutEmployeeComponentsDto) {
    return this.service.putForEmployee(req.dbClient!, employeeId, dto);
  }
}
