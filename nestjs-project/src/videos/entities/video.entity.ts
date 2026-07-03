import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Video processing state machine (TD-08):
 * `draft` → `processing` → `ready` | `failed`.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('videos')
export class Video {
  // The uuid PK doubles as the public URL identifier (TD-06 Decision B —
  // reuse the uuid, no separate nanoid column).
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  // S3 multipart UploadId held while the upload is in progress; cleared after
  // complete/abort (TD-02).
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  // Object key of the uploaded original — `videos/{id}/original.<ext>` (TD-03).
  @Column({ type: 'varchar', length: 512, nullable: true })
  original_key: string | null;

  // Object key of the generated thumbnail — `thumbnails/{id}/thumb.jpg` (TD-03/05).
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 127, nullable: true })
  content_type: string | null;

  // Original file size in bytes (≤ 10GB). bigint is required — 10GB overflows int4.
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  // Duration extracted by ffprobe (TD-05).
  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  // ffprobe-extracted metadata (width, height, codec, bitrate, container) (TD-05).
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  // Human-readable reason set on terminal (dead-lettered) failure (TD-08).
  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
