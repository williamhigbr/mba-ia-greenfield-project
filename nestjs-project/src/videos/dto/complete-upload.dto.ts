import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  /**
   * The part number (1-based), matching the presigned part order.
   * @example 1
   */
  @IsInt()
  @Min(1)
  partNumber: number;

  /**
   * The ETag returned by storage for the uploaded part.
   * @example "d41d8cd98f00b204e9800998ecf8427e"
   */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** The ETags of every uploaded part, used to assemble the final object. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
