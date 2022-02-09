export class Buf {
  public lastReadValue: any;
  public offset: number;
  public buffer: Buffer;
  constructor(buf?: Buffer, offset?: number) {
    this.buffer = buf ?? Buffer.allocUnsafe(0);
    this.offset = offset ?? 0;
  }
  public UIntLEToBuffer(number: number, byteLength?: number) {
    const buf = byteLength ? Buffer.alloc(byteLength) : Buffer.allocUnsafe(16);
    if (!number) {
      return buf.slice(0, 1).fill(number);
    }
    let index = 0;
    while (number > 0) {
      buf[index++] = number % 256;
      number = Math.floor(number / 256);
    }
    return byteLength ? buf : buf.slice(0, index);
  }
  public UIntBEToBuffer(number: number, byteLength?: number) {
    const buf = byteLength ? Buffer.alloc(byteLength) : Buffer.allocUnsafe(16);
    if (!number) {
      return buf.slice(0, 1).fill(number);
    }
    let index = buf.length;
    while (number > 0) {
      buf[--index] = number % 256;
      number = Math.floor(number / 256);
    }
    return byteLength ? buf : buf.slice(index);
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
    this.lastReadValue = this.buffer.slice(offset, (offset += length));
    this.offset = Math.min(offset, this.buffer.length);
    return this.lastReadValue;
  }
  public readString(length?: number, offset?: number): string {
    offset = offset ?? this.offset;
    this.lastReadValue = String(this.read(length || this.buffer.indexOf(0, offset) - offset, offset));
    if (!length) {
      this.offset = Math.min(this.offset + 1, this.buffer.length);
    }
    return this.lastReadValue;
  }
  public readUIntBE(byteLength: number, offset?: number): number {
    this.lastReadValue = this.buffer.readUIntBE((this.offset = offset ?? this.offset), byteLength);
    this.offset += byteLength;
    return this.lastReadValue;
  }
  public readUIntLE(byteLength: number, offset?: number): number {
    this.lastReadValue = this.buffer.readUIntLE((this.offset = offset ?? this.offset), byteLength);
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
  public writeStringNUL(str: string | Buffer, offset?: number) {
    return this.write(Buffer.concat([Buffer.from(str), this.UIntBEToBuffer(0)]), offset);
  }
  public writeStringPrefix(str: string | Buffer, prefixCallBackFn: (length: number) => Buffer, offset?: number) {
    return this.write(Buffer.concat([prefixCallBackFn(Buffer.byteLength(str)), Buffer.from(str)]), offset);
  }
}
