/**
 * 二进制数据处理模块
 * 提供高效的二进制数据读写操作，支持各种数据类型和字节序
 */

/**
 * 计算表示一个数字所需的字节长度
 * 根据数字大小、符号类型和增长方式计算所需的最少字节数
 * @param num 要计算的数字
 * @param isUnsigned 是否是无符号数，默认为true
 * @param isPower 是否使用2的幂次方增长（1,2,4,8字节），默认为false（使用线性增长1,2,3,4字节）
 * @returns 表示该数字所需的字节数
 */
export const getNumberLen = (
  /** 数字 */
  num = 0,
  /** 是否是无符号 */
  isUnsigned = true,
  /** 是否使用阶乘递增（1,2,3,4,5...）或（1,2,4,8,16...） */
  isPower = false,
) => {
  // 初始化计数器，表示所需的字节数
  let times = 1;
  // 设置位阈值，无符号数使用256（2^8），有符号数使用128（2^7）
  let bit = isUnsigned ? 256 : 128;
  // 如果是负数，转换为正数并减1（补码表示法）
  if (num < 0) {
    num *= -1;
    num -= 1;
  }
  // 无限循环，直到找到合适的字节长度
  while (1) {
    // 如果数字小于当前位阈值，返回所需的字节数
    if (num < bit) {
      return times;
    }
    // 根据isPower参数决定增长方式：指数增长或线性增长
    if (isPower) {
      times *= 2; // 指数增长：1,2,4,8,16...
    } else {
      times++; // 线性增长：1,2,3,4,5...
    }
    // 将数字除以256，相当于右移8位
    num /= 256;
  }
  // 理论上不会执行到这里，但为了完整性返回无穷大
  return Infinity;
};

/**
 * Buf类 - 二进制数据缓冲区操作类
 * 提供了一系列方法用于读写二进制数据，支持不同的数据类型和字节序
 * 实现了类似于Java的ByteBuffer或C#的BinaryReader/BinaryWriter的功能
 */
export class Buf {
  /**
   * 存储最后一次读取操作的值
   * 用于在链式调用中获取读取结果
   */
  public lastReadValue: any;

  /**
   * 当前缓冲区的偏移量
   * 表示下一次读写操作的起始位置
   */
  public offset: number;

  /**
   * 内部缓冲区
   * 存储实际的二进制数据
   */
  public buffer: Buffer;

  /**
   * 构造函数
   * @param buf 初始缓冲区，如果未提供则创建空缓冲区
   * @param offset 初始偏移量，默认为0
   */
  constructor(buf?: Buffer, offset?: number) {
    // 如果没有提供缓冲区，创建一个空的缓冲区
    this.buffer = buf ?? Buffer.allocUnsafe(0);
    // 如果没有提供偏移量，默认为0
    this.offset = offset ?? 0;
  }

  /**
   * 将无符号整数转换为小端序缓冲区
   * 小端序：低位字节在前，高位字节在后
   * @param number 要转换的数字
   * @param byteLength 字节长度，如果未指定则自动计算
   * @returns 包含数字的小端序缓冲区
   */
  public UIntLEToBuffer(number: number, byteLength?: number) {
    // 如果没有指定字节长度，自动计算所需的字节数
    byteLength = byteLength || getNumberLen(number, true);
    // 如果字节长度大于6，使用BigInt处理（Node.js的限制）
    if (byteLength > 6) {
      // 分配8字节的缓冲区
      const buf = Buffer.alloc(8);
      // 写入64位无符号整数（小端序）
      buf.writeBigUInt64LE(BigInt(number));
      // 返回指定长度的子缓冲区
      return buf.subarray(0, byteLength);
    } else {
      // 分配指定长度的缓冲区
      const buf = Buffer.alloc(byteLength);
      // 写入无符号整数（小端序）
      buf.writeUIntLE(number, 0, byteLength);
      // 返回缓冲区
      return buf;
    }
  }

  /**
   * 将无符号整数转换为大端序缓冲区
   * 大端序：高位字节在前，低位字节在后
   * @param number 要转换的数字
   * @param byteLength 字节长度，如果未指定则自动计算
   * @returns 包含数字的大端序缓冲区
   */
  public UIntBEToBuffer(number: number, byteLength?: number) {
    // 如果没有指定字节长度，自动计算所需的字节数
    byteLength = byteLength || getNumberLen(number, true);
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 分配8字节的缓冲区
      const buf = Buffer.alloc(8);
      // 写入64位无符号整数（大端序）
      buf.writeBigUInt64BE(BigInt(number));
      // 返回指定长度的子缓冲区，从末尾开始截取
      return buf.subarray(8 - byteLength);
    } else {
      // 分配指定长度的缓冲区
      const buf = Buffer.alloc(byteLength);
      // 写入无符号整数（大端序）
      buf.writeUIntBE(number, 0, byteLength);
      // 返回缓冲区
      return buf;
    }
  }

  /**
   * 将有符号整数转换为小端序缓冲区
   * @param number 要转换的数字
   * @param byteLength 字节长度，如果未指定则自动计算
   * @returns 包含数字的小端序缓冲区
   */
  public IntLEToBuffer(number: number, byteLength?: number) {
    // 如果没有指定字节长度，自动计算所需的字节数
    byteLength = byteLength || getNumberLen(number, false);
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 分配8字节的缓冲区
      const buf = Buffer.alloc(8);
      // 写入64位有符号整数（小端序）
      buf.writeBigInt64LE(BigInt(number));
      // 返回指定长度的子缓冲区
      return buf.subarray(0, byteLength);
    } else {
      // 分配指定长度的缓冲区
      const buf = Buffer.alloc(byteLength);
      // 写入有符号整数（小端序）
      buf.writeIntLE(number, 0, byteLength);
      // 返回缓冲区
      return buf;
    }
  }

  /**
   * 将有符号整数转换为大端序缓冲区
   * @param number 要转换的数字
   * @param byteLength 字节长度，如果未指定则自动计算
   * @returns 包含数字的大端序缓冲区
   */
  public IntBEToBuffer(number: number, byteLength?: number) {
    // 如果没有指定字节长度，自动计算所需的字节数
    byteLength = byteLength || getNumberLen(number, false);
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 分配8字节的缓冲区
      const buf = Buffer.alloc(8);
      // 写入64位有符号整数（大端序）
      buf.writeBigInt64BE(BigInt(number));
      // 返回指定长度的子缓冲区，从末尾开始截取
      return buf.subarray(8 - byteLength);
    } else {
      // 分配指定长度的缓冲区
      const buf = Buffer.alloc(byteLength);
      // 写入有符号整数（大端序）
      buf.writeIntBE(number, 0, byteLength);
      // 返回缓冲区
      return buf;
    }
  }

  /**
   * 分配指定长度的缓冲区并添加到当前缓冲区
   * 用于扩展当前缓冲区的容量
   * @param length 要分配的字节数
   * @param fill 填充值，如果提供则用该值填充新分配的缓冲区
   * @returns this引用，支持链式调用
   */
  public alloc(length: number, fill?: number) {
    // 创建指定长度的未初始化缓冲区
    const buf = Buffer.allocUnsafe(length);
    // 如果提供了填充值，用该值填充缓冲区
    if (fill !== undefined) {
      buf.fill(fill);
    }
    // 将新缓冲区连接到当前缓冲区并返回this引用
    return this.concat(buf);
  }

  /**
   * 将多个缓冲区连接到当前缓冲区
   * 用于合并多个Buffer对象
   * @param buf 要连接的缓冲区列表
   * @returns this引用，支持链式调用
   */
  public concat(...buf: Buffer[]) {
    // 将当前缓冲区与传入的缓冲区连接起来
    this.buffer = Buffer.concat([this.buffer, ...buf]);
    // 返回this引用，支持链式调用
    return this;
  }

  /**
   * 从缓冲区读取指定长度的数据
   * @param length 要读取的字节数，如果为负数则读取到缓冲区末尾
   * @param offset 读取的起始位置，默认为当前偏移量
   * @returns 读取的数据缓冲区
   */
  public read(length: number, offset?: number): Buffer {
    // 如果没有提供偏移量，使用当前偏移量
    offset = offset ?? this.offset;
    // 如果长度为负数，读取从偏移量到缓冲区末尾的所有数据
    length = length < 0 ? this.buffer.length - offset : length;
    // 读取数据并存储在lastReadValue中
    this.lastReadValue = this.buffer.subarray(offset, (offset += length));
    // 更新偏移量，确保不超过缓冲区长度
    this.offset = Math.min(offset, this.buffer.length);
    // 返回读取的数据
    return this.lastReadValue;
  }

  /**
   * 从缓冲区读取字符串
   * 如果未指定长度，则读取到第一个NULL字符（0）为止
   * @param length 要读取的字节数，如果未指定则读取到NULL字符
   * @param offset 读取的起始位置，默认为当前偏移量
   * @returns 读取的字符串
   */
  public readString(length?: number, offset?: number): string {
    // 如果没有提供偏移量，使用当前偏移量
    offset = offset ?? this.offset;
    // 如果没有提供长度，读取到第一个NULL字符（0）为止
    this.lastReadValue = String(this.read(length ?? this.buffer.indexOf(0, offset) - offset, offset));
    // 如果没有提供长度，偏移量增加1（跳过NULL字符）
    if (length === undefined) {
      this.offset = Math.min(this.offset + 1, this.buffer.length);
    }
    // 返回读取的字符串
    return this.lastReadValue;
  }

  /**
   * 从缓冲区读取大端序无符号整数
   * @param byteLength 要读取的字节数
   * @param offset 读取的起始位置，默认为当前偏移量
   * @returns 读取的整数值
   */
  public readUIntBE(byteLength: number, offset?: number): number {
    // 如果没有提供偏移量，使用当前偏移量
    this.offset = offset ?? this.offset;
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 从缓冲区获取指定长度的数据
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      // 如果数据长度不足8字节，在前面填充0
      if (buffer.length < 8) {
        buffer = Buffer.concat([Buffer.alloc(8 - buffer.length), buffer]);
      }
      // 读取64位无符号整数（大端序）并转换为Number
      this.lastReadValue = Number(buffer.readBigUInt64BE());
    } else {
      // 直接读取无符号整数（大端序）
      this.lastReadValue = this.buffer.readUIntBE(this.offset, byteLength);
    }
    // 更新偏移量
    this.offset += byteLength;
    // 返回读取的数值
    return this.lastReadValue;
  }

  /**
   * 从缓冲区读取小端序无符号整数
   * @param byteLength 要读取的字节数
   * @param offset 读取的起始位置，默认为当前偏移量
   * @returns 读取的整数值
   */
  public readUIntLE(byteLength: number, offset?: number): number {
    // 如果没有提供偏移量，使用当前偏移量
    this.offset = offset ?? this.offset;
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 从缓冲区获取指定长度的数据
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      // 如果数据长度不足8字节，在后面填充0
      if (buffer.length < 8) {
        buffer = Buffer.concat([buffer, Buffer.alloc(8 - buffer.length)]);
      }
      // 读取64位无符号整数（小端序）并转换为Number
      this.lastReadValue = Number(buffer.readBigUInt64LE());
    } else {
      // 直接读取无符号整数（小端序）
      this.lastReadValue = this.buffer.readUIntLE(this.offset, byteLength);
    }
    // 更新偏移量
    this.offset += byteLength;
    // 返回读取的数值
    return this.lastReadValue;
  }

  /**
   * 从缓冲区读取大端序有符号整数
   * @param byteLength 要读取的字节数
   * @param offset 读取的起始位置，默认为当前偏移量
   * @returns 读取的整数值
   */
  public readIntBE(byteLength: number, offset?: number): number {
    // 如果没有提供偏移量，使用当前偏移量
    this.offset = offset ?? this.offset;
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 从缓冲区获取指定长度的数据
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      // 如果数据长度不足8字节，在前面填充0
      if (buffer.length < 8) {
        buffer = Buffer.concat([Buffer.alloc(8 - buffer.length), buffer]);
      }
      // 读取64位有符号整数（大端序）并转换为Number
      this.lastReadValue = Number(buffer.readBigInt64BE());
    } else {
      // 直接读取有符号整数（大端序）
      this.lastReadValue = this.buffer.readIntBE(this.offset, byteLength);
    }
    // 更新偏移量
    this.offset += byteLength;
    // 返回读取的数值
    return this.lastReadValue;
  }

  /**
   * 从缓冲区读取小端序有符号整数
   * @param byteLength 要读取的字节数
   * @param offset 读取的起始位置，默认为当前偏移量
   * @returns 读取的整数值
   */
  public readIntLE(byteLength: number, offset?: number): number {
    // 如果没有提供偏移量，使用当前偏移量
    this.offset = offset ?? this.offset;
    // 如果字节长度大于6，使用BigInt处理
    if (byteLength > 6) {
      // 从缓冲区获取指定长度的数据
      let buffer = this.buffer.subarray(this.offset, this.offset + byteLength);
      // 如果数据长度不足8字节，在后面填充0
      if (buffer.length < 8) {
        buffer = Buffer.concat([buffer, Buffer.alloc(8 - buffer.length)]);
      }
      // 读取64位有符号整数（小端序）并转换为Number
      this.lastReadValue = Number(buffer.readBigInt64LE());
    } else {
      // 直接读取有符号整数（小端序）
      this.lastReadValue = this.buffer.readIntLE(this.offset, byteLength);
    }
    // 更新偏移量
    this.offset += byteLength;
    // 返回读取的数值
    return this.lastReadValue;
  }

  /**
   * 将数据写入缓冲区
   * @param buf 要写入的数据
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public write(buf: Buffer, offset?: number) {
    // 如果没有提供偏移量，使用当前偏移量
    offset = offset ?? this.offset;
    // 如果偏移量为负数，从缓冲区末尾开始写入
    this.offset = offset < 0 ? this.buffer.length : offset;
    // 如果当前缓冲区长度不足，扩展缓冲区
    if (this.buffer.length < offset + buf.length) {
      this.alloc(offset + buf.length - this.buffer.length);
    }
    // 逐字节写入数据
    buf.forEach(byte => {
      this.buffer[this.offset++] = byte;
    });
    // 返回this引用，支持链式调用
    return this;
  }

  /**
   * 写入大端序无符号整数
   * @param number 要写入的整数
   * @param byteLength 字节长度，如果未指定则自动计算
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public writeUIntBE(number: number, byteLength?: number, offset?: number) {
    // 将数字转换为大端序缓冲区并写入
    return this.write(this.UIntBEToBuffer(number, byteLength), offset);
  }

  /**
   * 写入小端序无符号整数
   * @param number 要写入的整数
   * @param byteLength 字节长度，如果未指定则自动计算
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public writeUIntLE(number: number, byteLength?: number, offset?: number) {
    // 将数字转换为小端序缓冲区并写入
    return this.write(this.UIntLEToBuffer(number, byteLength), offset);
  }

  /**
   * 写入大端序有符号整数
   * @param number 要写入的整数
   * @param byteLength 字节长度，如果未指定则自动计算
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public writeIntBE(number: number, byteLength?: number, offset?: number) {
    // 将数字转换为大端序缓冲区并写入
    return this.write(this.IntBEToBuffer(number, byteLength), offset);
  }

  /**
   * 写入小端序有符号整数
   * @param number 要写入的整数
   * @param byteLength 字节长度，如果未指定则自动计算
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public writeIntLE(number: number, byteLength?: number, offset?: number) {
    // 将数字转换为小端序缓冲区并写入
    return this.write(this.IntLEToBuffer(number, byteLength), offset);
  }

  /**
   * 写入以NULL结尾的字符串
   * 常用于C风格字符串，以\0结尾
   * @param str 要写入的字符串或缓冲区
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public writeStringNUL(str: string | Buffer, offset?: number) {
    // 将字符串转换为缓冲区，并在末尾添加NULL字符（0）
    return this.write(Buffer.concat([Buffer.from(str), this.UIntBEToBuffer(0)]), offset);
  }

  /**
   * 写入带前缀的字符串
   * 可以自定义前缀生成方式，通常用于表示字符串长度
   * @param str 要写入的字符串或缓冲区
   * @param prefixCallBackFn 前缀回调函数，接收字符串长度，返回前缀缓冲区
   * @param offset 写入的起始位置，默认为当前偏移量
   * @returns this引用，支持链式调用
   */
  public writeStringPrefix(
    str: string | Buffer,
    prefixCallBackFn?: (length: number) => Buffer | undefined,
    offset?: number,
  ) {
    // 调用前缀回调函数，传入字符串字节长度
    const buf = (prefixCallBackFn && prefixCallBackFn(Buffer.byteLength(str))) || undefined;
    // 如果有前缀，将前缀和字符串连接后写入；否则只写入字符串
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
