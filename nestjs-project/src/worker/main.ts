import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Video worker entrypoint (TD-04). Runs a headless NestJS application context
 * (no HTTP server) that reuses the API's modules/config and consumes the
 * pg-boss `video-process` queue. Shutdown hooks ensure pg-boss stops cleanly
 * on SIGTERM/SIGINT.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker started');
}

void bootstrap();
