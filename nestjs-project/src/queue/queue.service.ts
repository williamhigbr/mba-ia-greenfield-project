import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import PgBoss from 'pg-boss';
import queueConfig from '../config/queue.config';

/** Queue names — shared by the API (producer) and the worker (consumer). */
export const VIDEO_PROCESS_QUEUE = 'video-process';
export const VIDEO_PROCESS_DLQ = 'video-process-dlq';

/** Minimal job payload — the worker loads the row by id (TD-01/08). */
export interface VideoProcessingJob {
  videoId: string;
}

/**
 * Integrates pg-boss as the background processing queue (TD-01). Runs on the
 * shared PostgreSQL — no dedicated broker. `start()` bootstraps pg-boss's own
 * `pgboss` schema; queues are declared idempotently at boot. The same instance
 * shape is reused by the standalone worker (SI-03.9) to consume jobs.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly boss: PgBoss;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {
    this.boss = new PgBoss({
      connectionString: config.connectionString,
      schema: config.schema,
    });
    // pg-boss emits errors rather than throwing — always attach a listener.
    this.boss.on('error', (err) =>
      this.logger.error(
        'pg-boss error',
        err instanceof Error ? err.stack : err,
      ),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    // Declare the dead-letter queue first so the main queue can reference it.
    await this.boss.createQueue(VIDEO_PROCESS_DLQ);
    await this.boss.createQueue(VIDEO_PROCESS_QUEUE, {
      name: VIDEO_PROCESS_QUEUE,
      // `stately` enforces a unique index on (name, state, singleton_key) for
      // states <= active, so a second enqueue for the same videoId while a job
      // is still pending/active/retrying returns null instead of duplicating
      // (idempotent enqueue, TD-01). Orthogonal to retry/dead-letter handling.
      policy: 'stately',
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      deadLetter: VIDEO_PROCESS_DLQ,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }

  /**
   * Enqueues a video-processing job. `singletonKey = videoId` makes enqueue
   * idempotent: a second call for the same video while a job is still pending
   * does not create a duplicate (TD-01). Returns the job id, or null when
   * deduplicated.
   */
  async enqueueVideoProcessing(videoId: string): Promise<string | null> {
    return this.boss.send(
      VIDEO_PROCESS_QUEUE,
      { videoId } satisfies VideoProcessingJob,
      { singletonKey: videoId },
    );
  }

  /** The underlying pg-boss instance, for the worker to register handlers. */
  getBoss(): PgBoss {
    return this.boss;
  }
}
