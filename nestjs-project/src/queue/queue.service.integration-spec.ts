import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import {
  QueueService,
  VIDEO_PROCESS_DLQ,
  VIDEO_PROCESS_QUEUE,
} from './queue.service';

/**
 * Integration: real pg-boss against the shared DB. start() bootstraps the
 * `pgboss` schema; enqueue publishes real jobs.
 */
describe('QueueService (integration)', () => {
  let service: QueueService;
  let pg: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    service = moduleRef.get(QueueService);
    await service.onModuleInit();

    pg = new Client({ connectionString: queueConfig().connectionString });
    await pg.connect();
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    await pg.end();
  });

  it('bootstraps the pgboss schema and declares both queues on start', async () => {
    const schema = await pg.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'pgboss'`,
    );
    expect(schema.rowCount).toBe(1);

    // getQueueSize resolves only for declared queues — proves both exist.
    await expect(
      service.getBoss().getQueueSize(VIDEO_PROCESS_QUEUE),
    ).resolves.toEqual(expect.any(Number));
    await expect(
      service.getBoss().getQueueSize(VIDEO_PROCESS_DLQ),
    ).resolves.toEqual(expect.any(Number));
  });

  it('enqueueVideoProcessing creates exactly one job with the {videoId} payload', async () => {
    const videoId = randomUUID();
    const jobId = await service.enqueueVideoProcessing(videoId);
    expect(jobId).toBeTruthy();

    const res = await pg.query<{ id: string; data: { videoId: string } }>(
      `SELECT id, data FROM pgboss.job WHERE name = $1 AND data->>'videoId' = $2`,
      [VIDEO_PROCESS_QUEUE, videoId],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].data).toEqual({ videoId });
  });

  it('does not create a duplicate job for the same videoId (singletonKey)', async () => {
    const videoId = randomUUID();
    const first = await service.enqueueVideoProcessing(videoId);
    const second = await service.enqueueVideoProcessing(videoId);

    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const res = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pgboss.job WHERE name = $1 AND data->>'videoId' = $2`,
      [VIDEO_PROCESS_QUEUE, videoId],
    );
    expect(res.rows[0].c).toBe(1);
  });
});
