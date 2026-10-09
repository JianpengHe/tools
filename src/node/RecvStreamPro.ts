import * as stream from "stream";

type IRecvStreamProTask = {
  /** 返回true则允许继续读取，返回false则暂停读取 */
  onData(task: IRecvStreamProTask): void | Promise<void>;

  onEnd?: () => void;
  /** 剩余需要读取的大小 */
  needReadSize: number;
};

export class RecvStreamPro extends stream.Writable {
  /** 通知可读流，可以继续往RecvStreamPro写入数据 */
  private callback: ((error?: Error | null) => void) | undefined;

  /** 当前任务没消费完剩余的buffer */
  protected lastBuffer: Buffer = Buffer.allocUnsafe(0);

  /** read函数队列 */
  private taskQueue: IRecvStreamProTask[] = [];

  /** 当前正在处理的任务 */
  private task: IRecvStreamProTask | undefined;

  /** 新建task */
  public addTask(task: IRecvStreamProTask) {
    this.taskQueue.push(task);
    this.cleanTask().catch(err => this.destroy(err));
  }

  /** task队列锁 */
  private _writeLock = false;

  private async cleanTask() {
    if (this._writeLock) return;
    this._writeLock = true;

    try {
      while (this.task || (this.task = this.taskQueue.shift())) {
        /** 已读的数据未能满足需求 */
        if (this.lastBuffer.length < this.task.needReadSize) {
          if (this.isFinal) {
            /** 流结束了，但还有未完成的任务 */
            const res = this.task.onData(this.task);
            if (res instanceof Promise) await res;

            this.lastBuffer = Buffer.allocUnsafe(0);
            this.task.onEnd?.();
            this.task = undefined;
            continue;
          }
          break;
        }

        const res = this.task.onData(this.task);
        if (res instanceof Promise) await res;

        if (this.task && this.task.needReadSize <= 0) {
          this.task.onEnd?.();
          this.task = undefined;
        }
      }
    } catch (err) {
      // 捕捉任务执行中的异常，通知上游并销毁流
      if (this.callback) {
        const cb = this.callback;
        this.callback = undefined;
        cb(err as Error);
      }
      this.destroy(err as Error);
    } finally {
      this._writeLock = false;
      // 只有在未抛出异常（callback仍存在）时通知上游继续写入
      if (this.callback) {
        const cb = this.callback;
        this.callback = undefined;
        cb(null);
      }
    }
  }

  /** 接收到新数据时 */
  protected onData?: (chunk: Buffer) => Buffer;

  public _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    chunk = this.onData?.(chunk) ?? chunk;
    this.lastBuffer = this.lastBuffer.length ? Buffer.concat([this.lastBuffer, chunk]) : chunk;
    this.callback = callback;
    this.cleanTask().catch(err => callback(err));
  }

  public isFinal = false;

  public _final(callback: (error?: Error | null | undefined) => void): void {
    this.isFinal = true;
    this.cleanTask()
      .then(() => callback(null))
      .catch(callback);
  }

  public readableError: Error | null = null;

  public _destroy(error: Error | null, callback: (error?: Error | null | undefined) => void): void {
    this.readableError = error;
    this.isFinal = true;
    this.cleanTask()
      .then(() => callback(error))
      .catch(callback);
  }

  /** 读取特定长度的buffer */
  public readBuffer(size: number) {
    let returnValue: ((buffer: Buffer) => void) | Buffer | undefined;
    this.addTask({
      needReadSize: size,
      onData: task => {
        const buf = this.lastBuffer.subarray(0, size);
        this.lastBuffer = this.lastBuffer.subarray(size);
        task.needReadSize -= buf.length;
        if (typeof returnValue === "function") {
          returnValue(buf);
          return;
        }
        returnValue = buf;
      },
    });
    return (returnValue ||
      new Promise<Buffer>(resolve => {
        returnValue = resolve;
      })) as Promise<Buffer> | Buffer;
  }

  /** 读取固定长度的stream */
  public readStream(size: number) {
    let lastSize = size;
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
        if (recvStream.lastBuffer.length === 0) {
          taskReadable.destroy(new Error(`剩余${lastSize}字节未读取，但输入流已经结束`));
          return;
        }

        const readLen = Math.min(recvStream.lastBuffer.length, lastSize);
        const buf = recvStream.lastBuffer.subarray(0, readLen);
        recvStream.lastBuffer = recvStream.lastBuffer.subarray(readLen);
        lastSize -= buf.length;
        task.needReadSize = lastSize > 0 ? 1 : 0;

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

  /** 读取不定长的buffer，每次读到buffer都会触发onData回调，需要返回停止的index，也可以返回-1代表继续往下读 */
  public readBufferUnfixed(tempBufferMinSize: number, onData: (buffer: Buffer) => number) {
    if (tempBufferMinSize < 1) throw new Error("至少读一个字节到缓存里，不然会导致死循环");

    let returnValue: ((buffer: Buffer) => void) | Buffer | undefined;
    let taskTempBuffer: Buffer = Buffer.allocUnsafe(0);
    this.addTask({
      needReadSize: tempBufferMinSize,
      onData: task => {
        /** 满足要求前，流已经结束 */
        if (this.lastBuffer.length === 0) {
          const buf = taskTempBuffer.length ? taskTempBuffer : Buffer.alloc(0);
          if (typeof returnValue === "function") {
            returnValue(buf);
            return;
          }
          returnValue = buf;
          return;
        }

        // 计算上一次搜索未覆盖到的起始点，防止跨 Chunk 模式匹配漏掉
        const prevLen = taskTempBuffer.length;
        const startIndex = prevLen >= tempBufferMinSize ? prevLen - tempBufferMinSize + 1 : 0;

        taskTempBuffer = Buffer.concat([taskTempBuffer, this.lastBuffer]);
        this.lastBuffer = Buffer.alloc(0);

        const relativeIndex = onData(taskTempBuffer.subarray(startIndex));

        /** 还没结束，还没读到特定规则 */
        if (relativeIndex < 0) {
          return;
        }

        // 计算绝对匹配索引
        const matchIndex = startIndex + relativeIndex;
        this.lastBuffer = taskTempBuffer.subarray(matchIndex);
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
      new Promise<Buffer>(r => {
        returnValue = r;
      })) as Promise<Buffer> | Buffer;
  }

  /** 读取不定长的stream */
  public readStreamUnfixed(tempBufferMinSize: number, onData: (buffer: Buffer) => number) {
    if (tempBufferMinSize < 1) throw new Error("至少读一个字节到缓存里，不然会导致死循环");
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
      needReadSize: tempBufferMinSize,
      onData: task => {
        /** 满足要求前，流已经结束 */
        if (recvStream.lastBuffer.length === 0) {
          taskReadable.destroy(new Error(`在满足要求前，输入流已经结束`));
          return;
        }
        taskTempBuffer = Buffer.concat([taskTempBuffer, recvStream.lastBuffer]);
        recvStream.lastBuffer = Buffer.allocUnsafe(0);
        const index = onData(taskTempBuffer);
        /** 安全推送的位置：若未找到，保留 tempBufferMinSize - 1 个字节防止分隔符截断 */
        const curIndex = index < 0 ? Math.max(0, taskTempBuffer.length - tempBufferMinSize + 1) : index;

        const curBuffer = taskTempBuffer.subarray(0, curIndex);
        const lastBuffer = taskTempBuffer.subarray(curIndex);

        if (index < 0) {
          taskTempBuffer = lastBuffer;
        } else {
          taskTempBuffer = Buffer.allocUnsafe(0);
          recvStream.lastBuffer = lastBuffer;
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
}

// function sync<P extends any[], R>(fn: (callback: (v: R) => void, ...args: P) => void, ...args: P): R | Promise<R> {
//   let returnValue: ((value: R) => void) | R | undefined;
//   fn(
//     v => {
//       if (returnValue) {
//         // @ts-ignore
//         returnValue(v);
//         return;
//       }
//       returnValue = v;
//     },
//     ...args,
//   );
//   return (returnValue ||
//     new Promise<R>(r => {
//       returnValue = r;
//     })) as Promise<R> | R;
// }

// var a = () => true;

// (async () => {
//   await a();
//   console.log(1);
//   (async () => {
//     await a();
//     console.log(2);
//   })();
//   console.log(3);
// })();
// console.log(4);

// 测试用例
// import * as fs from "fs";
// const recvStreamPro = new RecvStreamPro();
// fs.createReadStream("4.bin").pipe(recvStreamPro);

// (async () => {
//   console.log(recvStreamPro.readBuffer(8));
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
//   recvStreamPro
//     .readStreamUnfixed(8, buf => {
//       // console.log(buf.length);
//       return buf.indexOf(Buffer.from("PG_!NB_!"));
//     })
//     .pipe(fs.createWriteStream("4.bin"));
//   console.log(String(await recvStreamPro.readBuffer(8)));
//   console.log(await recvStreamPro.readBuffer(32));
//   console.log(
//     recvStreamPro.readBufferUnfixed(1, buf => {
//       return buf.indexOf(Buffer.from([0xef]));
//     }).length,
//   );
//   console.log(recvStreamPro.readBuffer(8));
//   console.log(
//     recvStreamPro.readBufferUnfixed(1, buf => {
//       return buf.indexOf(Buffer.from([0xef]));
//     }).length,
//   );
//   console.log(recvStreamPro.readBuffer(8));
/** 测试在满足要求前，输入流已经结束 */
// recvStreamPro.readStream(0).pipe(fs.createWriteStream("41.bin"));
// recvStreamPro.readStreamUnfixed(1, () => 0).pipe(fs.createWriteStream("42.bin"));
// console.log(await recvStreamPro.readBuffer(2));
// console.log(2, recvStreamPro.readStream(800000000).pipe(fs.createWriteStream("43.bin")));
// console.log(2, await recvStreamPro.readBuffer(8000));
// })();

// fs.createReadStream("4.bin").pipe(recvStreamPro);
// (async () => {
//   console.log(await recvStreamPro.readBuffer(200 * 1024), recvStreamPro.isFinal);
//   console.log(await recvStreamPro.readBuffer(200 * 1024), recvStreamPro.isFinal);
//   console.log(await recvStreamPro.readBuffer(200 * 1024), recvStreamPro.isFinal);
// })();
