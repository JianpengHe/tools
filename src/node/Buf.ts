export const getNumberLen = (
  /** 数字 */
  num = 0,
  /** 是否是无符号 */
  isUnsigned = true,
  /** 是否使用阶乘递增（1,2,3,4,5...）或（1,2,4,8,16...） */
  isPower = false
) => {
  let times = 1;
  let bit = isUnsigned ? 256 : 128;
  if (num < 0) {
    num *= -1;
    num -= 1;
  }
  while (1) {
    if (num < bit) {
      return times;
    }
    if (isPower) {
      times *= 2;
    } else {
      times++;
    }
    num /= 256;
  }
  return Infinity;
};

export class Buf {
  public lastReadValue: any;
  public offset: number;
  public buffer: Buffer;
  constructor(buf?: Buffer, offset?: number) {
    this.buffer = buf ?? Buffer.allocUnsafe(0);
    this.offset = offset ?? 0;
  }

  public UIntLEToBuffer(number: number, byteLength?: number) {
    byteLength = byteLength || getNumberLen(number, true);
    if (byteLength > 6) {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(number));
      return buf.subarray(0, byteLength);
    } else {
      const buf = Buffer.alloc(byteLength);
      buf.writeUIntLE(number, 0, byteLength);
      return buf;
    }
  }
  public UIntBEToBuffer(number: number, byteLength?: number) {
    byteLength = byteLength || getNumberLen(number, true);
    if (byteLength > 6) {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(BigInt(number));
      return buf.subarray(8 - byteLength);
    } else {
      const buf = Buffer.alloc(byteLength);
      buf.writeUIntBE(number, 0, byteLength);
      return buf;
    }
  }
  public IntLEToBuffer(number: number, byteLength?: number) {
    byteLength = byteLength || getNumberLen(number, false);
    if (byteLength > 6) {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64LE(BigInt(number));
      return buf.subarray(0, byteLength);
    } else {
      const buf = Buffer.alloc(byteLength);
      buf.writeIntLE(number, 0, byteLength);
      return buf;
    }
  }
  public IntBEToBuffer(number: number, byteLength?: number) {
    byteLength = byteLength || getNumberLen(number, false);
    if (byteLength > 6) {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(BigInt(number));
      return buf.subarray(8 - byteLength);
    } else {
      const buf = Buffer.alloc(byteLength);
      buf.writeIntBE(number, 0, byteLength);
      return buf;
    }
  }

  public alloc(length: number, fill?: number) {
    const buf = Buffer.allocUnsafe(length);
    if (fill !== undefined) {
      buf.fill(fill);
    }
    return this.concat(buf);
  }
  public concat(...buf: Buffer[]) {
    this.buffer = Buffer.concat([this.buffer, ...buf]);
    return this;
  }
  public read(length: number, offset?: number): Buffer {
    offset = offset ?? this.offset;
    length = length < 0 ? this.buffer.length - offset : length;
    this.lastReadValue = this.buffer.subarray(offset, (offset += length));
    this.offset = Math.min(offset, this.buffer.length);
    return this.lastReadValue;
  }
  public readString(length?: number, offset?: number): string {
    offset = offset ?? this.offset;
    this.lastReadValue = String(this.read(length ?? this.buffer.indexOf(0, offset) - offset, offset));
    if (length === undefined) {
      this.offset = Math.min(this.offset + 1, this.buffer.length);
    }
    return this.lastReadValue;
  }

  public readUIntBE(byteLength: number, offset?: number): number {
    this.offset = offset ?? this.offset;
    if (byteLength > 6) {
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      if (buffer.length < 8) {
        buffer = Buffer.concat([Buffer.alloc(8 - buffer.length), buffer]);
      }
      this.lastReadValue = Number(buffer.readBigUInt64BE());
    } else {
      this.lastReadValue = this.buffer.readUIntBE(this.offset, byteLength);
    }
    this.offset += byteLength;
    return this.lastReadValue;
  }
  public readUIntLE(byteLength: number, offset?: number): number {
    this.offset = offset ?? this.offset;
    if (byteLength > 6) {
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      if (buffer.length < 8) {
        buffer = Buffer.concat([buffer, Buffer.alloc(8 - buffer.length)]);
      }
      this.lastReadValue = Number(buffer.readBigUInt64LE());
    } else {
      this.lastReadValue = this.buffer.readUIntLE(this.offset, byteLength);
    }
    this.offset += byteLength;
    return this.lastReadValue;
  }
  public readIntBE(byteLength: number, offset?: number): number {
    this.offset = offset ?? this.offset;
    if (byteLength > 6) {
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      if (buffer.length < 8) {
        buffer = Buffer.concat([Buffer.alloc(8 - buffer.length), buffer]);
      }
      this.lastReadValue = Number(buffer.readBigInt64BE());
    } else {
      this.lastReadValue = this.buffer.readIntBE(this.offset, byteLength);
    }
    this.offset += byteLength;
    return this.lastReadValue;
  }
  public readIntLE(byteLength: number, offset?: number): number {
    this.offset = offset ?? this.offset;
    if (byteLength > 6) {
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      if (buffer.length < 8) {
        buffer = Buffer.concat([buffer, Buffer.alloc(8 - buffer.length)]);
      }
      this.lastReadValue = Number(buffer.readBigInt64LE());
    } else {
      this.lastReadValue = this.buffer.readIntLE(this.offset, byteLength);
    }
    this.offset += byteLength;
    return this.lastReadValue;
  }

  public write(buf: Buffer, offset?: number) {
    offset = offset ?? this.offset;
    this.offset = offset < 0 ? this.buffer.length : offset;
    if (this.buffer.length < offset + buf.length) {
      this.alloc(offset + buf.length - this.buffer.length);
    }
    buf.forEach(byte => {
      this.buffer[this.offset++] = byte;
    });
    return this;
  }

  public writeUIntBE(number: number, byteLength?: number, offset?: number) {
    return this.write(this.UIntBEToBuffer(number, byteLength), offset);
  }
  public writeUIntLE(number: number, byteLength?: number, offset?: number) {
    return this.write(this.UIntLEToBuffer(number, byteLength), offset);
  }
  public writeIntBE(number: number, byteLength?: number, offset?: number) {
    return this.write(this.IntBEToBuffer(number, byteLength), offset);
  }
  public writeIntLE(number: number, byteLength?: number, offset?: number) {
    return this.write(this.IntLEToBuffer(number, byteLength), offset);
  }

  public writeStringNUL(str: string | Buffer, offset?: number) {
    return this.write(Buffer.concat([Buffer.from(str), this.UIntBEToBuffer(0)]), offset);
  }
  public writeStringPrefix(
    str: string | Buffer,
    prefixCallBackFn?: (length: number) => Buffer | undefined,
    offset?: number
  ) {
    const buf = (prefixCallBackFn && prefixCallBackFn(Buffer.byteLength(str))) || undefined;
    return this.write(buf ? Buffer.concat([buf, Buffer.from(str)]) : Buffer.from(str), offset);
  }
}

// 测试用例

// const byte = 7;
// const buf = new Buf(Buffer.alloc(8));
// const buffer = Buffer.alloc(8);
// let num = 2 ** (byte * 8 - 1) * 2; //- 1024;

// buf.writeUIntBE(num, undefined, 8 - byte);
// buffer.writeBigUInt64BE(BigInt(num));
// console.log(
//   buf.buffer,
//   buffer,
//   num,
//   new Buf(buffer).readUIntBE(byte, 8 - byte),
//   buf.buffer.readBigUInt64BE()
// );

// buf.writeUIntLE(num);
// buffer.writeBigUInt64LE(BigInt(num));
// console.log(buf.buffer, buffer, num, new Buf(buffer).readUIntLE(byte), buf.buffer.readBigUInt64LE());

// buf.writeIntLE(num);
// buffer.writeBigInt64LE(BigInt(num));
// console.log(buf.buffer, buffer, num, new Buf(buffer).readIntLE(byte), buf.buffer.readBigInt64LE());

// buf.writeIntBE(num);
// buffer.writeBigInt64BE(BigInt(num));
// console.log(buf.buffer, buffer, num, new Buf(buffer).readIntBE(8), buf.buffer.readBigInt64BE());
