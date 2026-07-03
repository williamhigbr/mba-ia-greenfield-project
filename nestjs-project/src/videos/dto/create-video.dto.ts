import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateVideoDto {
  /**
   * Original file name — used to derive the title and the object extension.
   * @example clip.mp4
   */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /**
   * MIME type of the file. Must be a `video/*` type.
   * @example video/mp4
   */
  @IsString()
  @IsNotEmpty()
  contentType: string;

  /**
   * Total file size in bytes (1 … 10737418240 / 10GB).
   * @example 52428800
   */
  @IsInt()
  @Min(1)
  size: number;
}
