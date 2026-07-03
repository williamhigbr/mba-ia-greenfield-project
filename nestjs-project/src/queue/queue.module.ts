import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QueueService } from './queue.service';

@Module({
  imports: [ConfigModule.forFeature(queueConfig)],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
