import * as stream from "stream";

type IRecvStreamProTask = {
  /** 消费数据的回调函数，支持异步 Promise */
  onData(task: IRecvStreamProTask): void | Promise<void>;

  /** 任务正常消费完成后的回调 */
  onEnd?: () => void;

  /** 剩余需要读取的大小 */
  needReadSize: number;
};

export class RecvStreamPro extends stream.Writable {
  /** 通知可读流，可以继续往RecvStreamPro写入数据 */
  private writeCallback: ((error?: Error | null) => void) | undefined;

  /** 当前任务没消费完剩余的buffer */
  protected restBuffer: Buffer = Buffer.allocUnsafe(0);

  /** read函数队列 */
  private taskQueue: IRecvStreamProTask[] = [];

  /** 当前正在处理的任务 */
  private task: IRecvStreamProTask | undefined;

  /** 背压水位上限（默认 16KB），动态水位为 Math.max(this.highWaterMark, this.task?.needReadSize ?? 0) */
  public highWaterMark: number = 16 * 1024;

  /** 新建task */
  public addTask(task: IRecvStreamProTask) {
    if (this.isFinal) throw new Error("流已经结束，无法添加新任务");
    this.taskQueue.push(task);
    this.cleanQueue().catch(err => this.destroy(err));
  }

  /** task队列锁，防止并发重入 */
  private _taskLock = false;

  private async cleanQueue() {
    if (this._taskLock) return;
    this._taskLock = true;

    try {
      while (this.task || (this.task = this.taskQueue.shift())) {
        /** 已读的数据未能满足需求 */
        if (this.restBuffer.length < this.task.needReadSize) {
          if (this.writableEnded || this.destroyed) {
            /**
             * 流结束了，但还有未完成的任务。
             * 此处采取激进失败策略：直接清空剩余碎片缓冲区并终结任务。
             * 在二进制协议解析中，上一任务数据不足意味着整个数据流的字节序已失序，后续任务无法继续安全执行。
             */
            const res = this.task.onData(this.task);
            if (RecvStreamPro.isPromise(res)) await res;

            this.restBuffer = Buffer.allocUnsafe(0);
            this.task.onEnd?.();
            this.task = undefined;
            continue;
          }
          break;
        }

        const res = this.task.onData(this.task);
        if (RecvStreamPro.isPromise(res)) await res;

        if (this.task && this.task.needReadSize <= 0) {
          this.task.onEnd?.();
          this.task = undefined;
        }
      }

      if ((this.writableEnded || this.destroyed) && this.restBuffer.length === 0) this.isFinal = true;
    } catch (err) {
      // 捕捉任务执行中的异常，通知上游并销毁流
      if (this.writeCallback) {
        const cb = this.writeCallback;
        this.writeCallback = undefined;
        cb(err as Error);
      }
      this.destroy(err as Error);
    } finally {
      this._taskLock = false;
      // 背压流控：只有未抛出异常且当前缓冲区水位低于阈值时，才唤醒上游继续写入
      if (this.writeCallback) {
        const waterMark = Math.max(this.highWaterMark, this.task?.needReadSize ?? 0);
        if (this.restBuffer.length < waterMark) {
          const cb = this.writeCallback;
          this.writeCallback = undefined;
          cb(null);
        }
      }
    }
  }

  /** 接收到新数据时 */
  protected onData?: (chunk: Buffer) => Buffer;

  public _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    chunk = this.onData?.(chunk) ?? chunk;
    this.restBuffer = this.restBuffer.length ? Buffer.concat([this.restBuffer, chunk]) : chunk;
    this.writeCallback = callback;
    this.cleanQueue().catch(err => callback(err));
  }

  /**
   * 流终态标记。
   * 当上游流已断开/销毁，且缓冲区（restBuffer）中已无剩余数据时为 true。
   * 为 true 时表示流已彻底终结，禁止再创建新的消费 task。
   */
  public isFinal = false;

  public streamError: Error | null = null;

  private finalFn(error: Error | null, callback: (error?: Error | null | undefined) => void): void {
    this.streamError = error;
    this.cleanQueue().finally(() => {
      if (this.restBuffer.length === 0) this.isFinal = true;
      callback(error);
    });
  }

  public _final(callback: (error?: Error | null | undefined) => void): void {
    this.finalFn(null, callback);
  }

  public _destroy(error: Error | null, callback: (error?: Error | null | undefined) => void): void {
    this.finalFn(error, callback);
  }

  /**
   * 读取特定长度的buffer。
   * 注意（Zalgo 模式）：
   * 当缓冲区数据充足时会同步返回 Buffer，以提高密集小包解析性能并防止 Promise 递归调用栈溢出；
   * 仅在数据不足时返回 Promise<Buffer>。若调用端无特殊性能要求，统一使用 await 即可安全消费。
   */
  public readBuffer(size: number) {
    let returnValue: ((buffer: Buffer) => void) | Buffer | undefined;
    let rejectValue: ((err: Error) => void) | undefined;
    this.addTask({
      needReadSize: size,
      onData: task => {
        if (this.restBuffer.length < task.needReadSize && (this.writableEnded || this.destroyed)) {
          const err = this.streamError ?? new Error(`剩余${task.needReadSize}字节未读取，但输入流已经结束`);
          if (typeof rejectValue === "function") {
            rejectValue(err);
            return;
          }
          throw err;
        }
        const buf = this.restBuffer.subarray(0, size);
        this.restBuffer = this.restBuffer.subarray(size);
        task.needReadSize -= buf.length;
        if (typeof returnValue === "function") {
          returnValue(buf);
          return;
        }
        returnValue = buf;
      },
    });
    return (returnValue ||
      new Promise<Buffer>((resolve, reject) => {
        returnValue = resolve;
        rejectValue = reject;
      })) as Promise<Buffer> | Buffer;
  }

  /** 读取固定长度的stream */
  public readStream(size: number) {
    let restSize = size;
    const recvStream = this;
    let resolveFn: (() => void) | undefined;
    const taskReadable = new stream.Readable({
      read() {
        resolveFn?.();
        resolveFn = undefined;
      },
    });

    recvStream.addTask({
      needReadSize: 1,
      onData: task => {
        /** 满足要求前，流已经结束 */
        if (recvStream.restBuffer.length === 0) {
          taskReadable.destroy(recvStream.streamError ?? new Error(`剩余${restSize}字节未读取，但输入流已经结束`));
          return;
        }

        const readLen = Math.min(recvStream.restBuffer.length, restSize);
        const buf = recvStream.restBuffer.subarray(0, readLen);
        recvStream.restBuffer = recvStream.restBuffer.subarray(readLen);
        restSize -= buf.length;
        task.needReadSize = restSize > 0 ? 1 : 0;

        if (buf.length > 0 && taskReadable.push(buf) === false) {
          return new Promise<void>(resolve => {
            resolveFn = resolve;
          });
        }
        return;
      },
      onEnd: () => taskReadable.push(null),
    });

    return taskReadable;
  }

  /**
   * 读取不定长的buffer。
   * 每次累积不少于 minChunkSize 字节后触发 onData 回调，返回停止索引，返回 -1 代表未匹配到需继续读取。
   * 注意（Zalgo 模式）：数据命中时同步返回 Buffer，未满足时返回 Promise<Buffer>。
   */
  public readBufferUnfixed(minChunkSize: number, onData: (buffer: Buffer) => number) {
    if (minChunkSize < 1) throw new Error("至少读一个字节到缓存里，不然会导致死循环");

    let returnValue: ((buffer: Buffer) => void) | Buffer | undefined;
    let rejectValue: ((err: Error) => void) | undefined;
    let taskTempBuffer: Buffer = Buffer.allocUnsafe(0);
    this.addTask({
      needReadSize: minChunkSize,
      onData: task => {
        /** 满足要求前，流已经结束 */
        if (this.restBuffer.length === 0) {
          const err = this.streamError ?? new Error("未找到匹配的数据，输入流已经结束");
          if (typeof rejectValue === "function") {
            rejectValue(err);
            return;
          }
          throw err;
        }

        // 计算上一次搜索未覆盖到的起始点，防止跨 Chunk 模式匹配漏掉
        const prevLen = taskTempBuffer.length;
        const startIndex = prevLen >= minChunkSize ? prevLen - minChunkSize + 1 : 0;

        taskTempBuffer = Buffer.concat([taskTempBuffer, this.restBuffer]);
        this.restBuffer = Buffer.alloc(0);

        const relativeIndex = onData(taskTempBuffer.subarray(startIndex));

        /** 还没结束，还没读到特定规则 */
        if (relativeIndex < 0) {
          if (this.writableEnded || this.destroyed) {
            const err = this.streamError ?? new Error("未找到匹配的数据，输入流已经结束");
            if (typeof rejectValue === "function") {
              rejectValue(err);
              return;
            }
            throw err;
          }
          return;
        }

        // 计算绝对匹配索引
        const matchIndex = startIndex + relativeIndex;
        this.restBuffer = taskTempBuffer.subarray(matchIndex);
        const buf = taskTempBuffer.subarray(0, matchIndex);
        task.needReadSize = 0;

        if (typeof returnValue === "function") {
          returnValue(buf);
          return;
        }
        returnValue = buf;
      },
    });
    return (returnValue ||
      new Promise<Buffer>((r, rej) => {
        returnValue = r;
        rejectValue = rej;
      })) as Promise<Buffer> | Buffer;
  }

  /** 读取不定长的stream */
  public readStreamUnfixed(minChunkSize: number, onData: (buffer: Buffer) => number) {
    if (minChunkSize < 1) throw new Error("至少读一个字节到缓存里，不然会导致死循环");
    let resolveFn: (() => void) | undefined;
    let taskTempBuffer: Buffer = Buffer.allocUnsafe(0);
    const taskReadable = new stream.Readable({
      read() {
        resolveFn?.();
        resolveFn = undefined;
      },
    });
    const recvStream = this;
    this.addTask({
      needReadSize: minChunkSize,
      onData: task => {
        /** 满足要求前，流已经结束 */
        if (recvStream.restBuffer.length === 0) {
          taskReadable.destroy(recvStream.streamError ?? new Error(`在满足要求前，输入流已经结束`));
          return;
        }
        taskTempBuffer = Buffer.concat([taskTempBuffer, recvStream.restBuffer]);
        recvStream.restBuffer = Buffer.allocUnsafe(0);
        const index = onData(taskTempBuffer);
        /** 安全推送的位置：若未找到，保留 minChunkSize - 1 个字节防止分隔符截断 */
        const curIndex = index < 0 ? Math.max(0, taskTempBuffer.length - minChunkSize + 1) : index;

        const curBuffer = taskTempBuffer.subarray(0, curIndex);
        const restBuffer = taskTempBuffer.subarray(curIndex);

        if (index < 0) {
          taskTempBuffer = restBuffer;
        } else {
          taskTempBuffer = Buffer.allocUnsafe(0);
          recvStream.restBuffer = restBuffer;
          task.needReadSize = 0;
        }

        if (curBuffer.length > 0 && taskReadable.push(curBuffer) === false)
          return new Promise<void>(resolve => {
            resolveFn = resolve;
          });
        return;
      },
      onEnd: () => taskReadable.push(null),
    });

    return taskReadable;
  }

  static isPromise<T>(val: T | Promise<T>): val is Promise<T> {
    return val instanceof Promise;
  }
}

// 测试用例
// import * as fs from "fs";

// // 用例1：基础读取与定长流切分
// (async () => {
//   const recvStreamPro = new RecvStreamPro();
//   fs.createReadStream("4.bin").pipe(recvStreamPro);

//   console.log(await recvStreamPro.readBuffer(8));
//   await new Promise(r => setTimeout(r, 2000));
//   const f = fs.createWriteStream("t.bin");
//   recvStreamPro.readStream(256000).pipe(f);
//   await new Promise(r => f.once("close", r));
//   await new Promise(r => setTimeout(r, 2000));
//   console.log(await recvStreamPro.readBuffer(25600));
//   await new Promise(r => setTimeout(r, 2000));
//   const f2 = fs.createWriteStream("t2.bin");
//   recvStreamPro.readStream(256000).pipe(f2);
//   fs.createReadStream("t.bin", {
//     start: 16 + 256000 + 25600,
//     end: 16 + 256000 + 25600 - 1 + 256000,
//   }).pipe(fs.createWriteStream("t3.bin"));
//   console.log(await recvStreamPro.readBuffer(16));
//
//   // 注意：写入文件避免直接覆盖正在读取的输入源 "4.bin"，建议写入新文件如 "output_pattern.bin"
//   recvStreamPro
//     .readStreamUnfixed(8, buf => {
//       // console.log(buf.length);
//       return buf.indexOf(Buffer.from("PG_!NB_!"));
//     })
//     .pipe(fs.createWriteStream("output_pattern.bin"));
//
//   console.log(String(await recvStreamPro.readBuffer(8)));
//   console.log(await recvStreamPro.readBuffer(32));
//
//   // 修正：readBufferUnfixed 返回 Promise<Buffer> | Buffer，必须 await 才能安全获取 .length
//   const unfixedBuf1 = await recvStreamPro.readBufferUnfixed(1, buf => buf.indexOf(Buffer.from([0xef])));
//   console.log(unfixedBuf1.length);
//
//   console.log(await recvStreamPro.readBuffer(8));
//
//   const unfixedBuf2 = await recvStreamPro.readBufferUnfixed(1, buf => buf.indexOf(Buffer.from([0xef])));
//   console.log(unfixedBuf2.length);
//
//   console.log(await recvStreamPro.readBuffer(8));
//
//   /** 测试在满足要求前，输入流已经结束的容错与报错处理 */
//   try {
//     recvStreamPro.readStream(0).pipe(fs.createWriteStream("41.bin"));
//     recvStreamPro.readStreamUnfixed(1, () => 0).pipe(fs.createWriteStream("42.bin"));
//     console.log(await recvStreamPro.readBuffer(2));
//     recvStreamPro.readStream(800000000).pipe(fs.createWriteStream("43.bin"));
//     console.log(2, await recvStreamPro.readBuffer(8000));
//   } catch (err) {
//     console.error("捕获到流提前截断预期的错误:", (err as Error).message);
//   }
// })();

// // 用例2：测试 isFinal 判定（建议使用新实例，避免与用例1的输入源和状态冲突）
// (async () => {
//   const recvStreamPro2 = new RecvStreamPro();
//   fs.createReadStream("4.bin").pipe(recvStreamPro2);
//   try {
//     console.log(await recvStreamPro2.readBuffer(200 * 1024), "isFinal:", recvStreamPro2.isFinal);
//     console.log(await recvStreamPro2.readBuffer(200 * 1024), "isFinal:", recvStreamPro2.isFinal);
//     console.log(await recvStreamPro2.readBuffer(200 * 1024), "isFinal:", recvStreamPro2.isFinal);
//   } catch (err) {
//     console.log("读取结束或不足:", (err as Error).message, "isFinal:", recvStreamPro2.isFinal);
//   }
// })();
