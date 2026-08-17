import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppService, HealthResponse } from './app.service';
import { Public } from './common/decorators/public.decorator';

/**
 * `GET /health` — excluded from the global `api` prefix in `main.ts`
 * (`setGlobalPrefix('api', { exclude: ['health'] })`) so it is reachable at
 * the bare path `docker-compose.yml`'s healthcheck already expects:
 * `http://localhost:4000/health`. Returns 503 (not 200) when degraded so
 * that healthcheck — which only checks `response.ok` — actually fails.
 */
@Controller('health')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const result = await this.appService.checkHealth();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
