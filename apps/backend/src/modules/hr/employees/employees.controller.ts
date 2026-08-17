import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Employee, EmploymentStatus, Paginated } from '@mimi/shared';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { CreateEmployeeDto, UpdateEmployeeDto } from '../dto/employee.dto';
import { EmployeeDetail, EmployeesService } from './employees.service';

/** CONTRACTS.md §4.14 — `/api/hr/employees*`. */
@Controller('api/hr/employees')
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  @RequirePermission('hr.employee.read')
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('status') status?: EmploymentStatus,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<Employee>> {
    return this.service.list(
      req.dbClient!,
      locationId,
      status,
      q,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  @Get(':id')
  @RequirePermission('hr.employee.read')
  async getById(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<EmployeeDetail> {
    // Salary is only included in the response when the caller ALSO holds `hr.employee.manage`
    // (CONTRACTS.md §4.14: "salary needs hr.employee.manage") — `hr.employee.read` alone (e.g.
    // Supervisor) sees the roster/position history without base_salary.
    const includeSalary = ['owner', 'manager', 'hr_admin'].includes(req.user!.roleKey);
    return this.service.getById(req.dbClient!, id, includeSalary);
  }

  @Post()
  @RequirePermission('hr.employee.manage')
  @Audited({ module: 'hr', entityType: 'employees', action: 'hr.employee.manage' })
  async create(@Req() req: RequestWithDbContext, @Body() dto: CreateEmployeeDto): Promise<Employee> {
    return this.service.create(req.dbClient!, req.user!.sub, dto);
  }

  @Patch(':id')
  @RequirePermission('hr.employee.manage')
  @Audited({ module: 'hr', entityType: 'employees', action: 'hr.employee.manage' })
  async update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<Employee> {
    return this.service.update(req.dbClient!, req.user!.sub, id, dto);
  }
}
