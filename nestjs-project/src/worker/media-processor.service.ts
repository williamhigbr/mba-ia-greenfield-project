import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';

export interface ProbeResult {
  durationSeconds: number;
  metadata: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: FfprobeStream[];
}

/**
 * Thin wrapper around the system `ffprobe`/`ffmpeg` binaries via Node
 * `child_process` (TD-05 — no fluent-ffmpeg wrapper). Injectable so the worker
 * service can be unit-tested with a mocked processor.
 */
@Injectable()
export class MediaProcessorService {
  /** Extracts duration (seconds) and basic metadata via `ffprobe -print_format json`. */
  async probe(filePath: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');

    const rawDuration = parsed.format?.duration ?? videoStream?.duration ?? '0';
    const durationSeconds = Math.max(0, Math.round(Number(rawDuration) || 0));

    const metadata: Record<string, unknown> = {
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      bitRate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
      container: parsed.format?.format_name ?? null,
    };

    return { durationSeconds, metadata };
  }

  /** Captures a single frame at `atSeconds` into `outPath` as a JPEG. */
  async extractThumbnail(
    filePath: string,
    outPath: string,
    atSeconds: number,
  ): Promise<void> {
    await this.run('ffmpeg', [
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outPath,
    ]);
  }

  /** Spawns a binary, resolving stdout on exit 0, rejecting with stderr otherwise. */
  private run(command: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `${command} exited with code ${code ?? 'null'}: ${stderr}`,
            ),
          );
        }
      });
    });
  }
}
