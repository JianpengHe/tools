import * as stream from "stream";
import { IReadStream } from "./utils";

export type IRecvStreamReadBuffer = (
  readSize: number | ((byte: number) => boolean),
  callback: (buffer: Buffer) => void
) => void;
export type IRecvStreamReadStream = (
  readSize: number,
  callback: (stream: SubReadStream) => void,
  onClose?: () => void
) => void;
type IRecvStreamQueueBuffer = {
  type: "buffer";
  readSize: number | ((byte: number) => boolean);
  callback: Parameters<IRecvStreamReadBuffer>[1];
};
type IRecvStreamQueueStream = {
  type: "stream";
  readSize: number;
  callback: Parameters<IRecvStreamReadStream>[1];
  onClose?: () => void;
};
type IRecvStreamQueue = IRecvStreamQueueBuffer | IRecvStreamQueueStream;
export class RecvStream {
  /** 源可读流 */
  public sourceStream: IReadStream;

  /** 临时储存 */
  private tempBuffer: Buffer[] = [];

  /** 临时储存的字节数 */
  private tempBufferSize: number = 0;

  /** 剩余未接受的字节数 */
  private bufferRemainSize: number = 0;

  /** 不定长buffer的长度 */
  private bufferLen: number = 0;

  /** read函数队列 */
  private taskQueue: IRecvStreamQueue[] = [];

  /** 当前正在处理的任务 */
  private task?: IRecvStreamQueue;

  /** 新建task */
  private newTask() {
    if (
      this.task || // 正在执行
      this.taskQueue.length === 0 || // 队列里没任务了
      !(this.task = this.taskQueue.splice(0, 1)[0]) // 取不到第一个任务
    ) {
      // console.log("等待任务");
      return;
    }
    if (this.task.type === "buffer") {
      this.bufferLen = 0;
      /** 不定长buffer至少需要读1个字节 */
      this.bufferRemainSize = Number(this.task.readSize) || 1;
      this.read();
    } else {
      /** 这边的流要先暂停，子流才能读取 */
      this.sourceStream.pause();

      /** 需要把已经读出来的内存退回去 */
      this.sourceStream.unshift(Buffer.concat(this.tempBuffer));

      /** 清空 */
      this.tempBuffer.length = 0;
      this.tempBufferSize = 0;

      this.task.callback(
        new SubReadStream(this.sourceStream, this.task.readSize, () => {
          const task = this.task as IRecvStreamQueueStream;
          if (task.onClose) {
            task.onClose();
          }
          this.task = undefined;
          this.newTask();
        })
      );
    }
  }
  private read() {
    /** 当前读取到的字节数没有满足开发者的需求 */
    if (this.bufferRemainSize > this.tempBufferSize) {
      if (!this.sourceStream.readableFlowing) {
        /** 别停下来 */
        this.sourceStream.resume();
      }
      this.sourceStream.once("data", chuck => {
        this.tempBufferSize += chuck.length;
        this.tempBuffer.push(chuck);
        this.read();
      });
      return;
    }

    /** buffer数组合并成一个大块，并且放在数组第0位 */
    if (this.tempBuffer.length > 0) {
      this.tempBuffer[0] = Buffer.concat([...this.tempBuffer]);
      //  this.tempBuffer.length = 1;
    }
    const buffer = this.tempBuffer[0];
    if (this.task) {
      const task = this.task as IRecvStreamQueueBuffer;
      if (task.readSize instanceof Function) {
        /** 只遍历最后一次获取到的内存块 */
        for (const byte of this.tempBuffer[this.tempBuffer.length - 1]) {
          this.bufferLen++;
          this.bufferRemainSize++;
          if (task.readSize(byte)) {
            task.readSize = this.bufferLen;
            break;
          }
        }
        /** 清空数组，只保留合并后的第0位 */
        this.tempBuffer.length = 1;

        /** 如果还是函数，说明当前拿到的数据还没满足开发者的要求，继续read */
        if (task.readSize instanceof Function) {
          this.read();
          return;
        }
      } else {
        /** 清空数组，只保留合并后的第0位 */
        this.tempBuffer.length = 1;
      }
      task.callback(buffer.subarray(0, task.readSize));
      this.tempBufferSize -= task.readSize;
      /** 截取并去掉已交付开发者的数据块 */
      this.tempBuffer[0] = buffer.subarray(task.readSize);
      /** 清空当前任务 */
      this.task = undefined;
    }
    if (this.taskQueue.length) {
      this.newTask();
    } else {
      /** 队列里没读取任务了，先停一下 */
      this.sourceStream.pause();
    }
  }
  constructor(sourceStream: IReadStream) {
    this.sourceStream = sourceStream;
    sourceStream.pause();
    sourceStream["t"] = this;
  }

  /** readBuffer的“同步”写法 */
  public readBufferSync: (
    readSize: number | ((byte: number) => boolean),
    unshift?: boolean
  ) => Promise<Buffer> | Buffer = (readSize, unshift = false) => {
    if (this.tempBuffer.length > 0) {
      this.tempBuffer[0] = Buffer.concat([...this.tempBuffer]);
      this.tempBuffer.length = 1;
    }
    if (readSize instanceof Function) {
      const index = this.tempBuffer[0].findIndex(readSize);
      if (index >= 0) {
        readSize = index;
      }
    }
    if (!(readSize instanceof Function) && this.tempBufferSize >= readSize) {
      const buffer = this.tempBuffer[0];
      this.tempBuffer[0] = buffer.subarray(readSize);
      this.tempBufferSize = this.tempBuffer[0].length;
      return buffer.subarray(0, readSize);
    }
    return new Promise(resolve => {
      this.addNewTask({ type: "buffer", readSize, callback: resolve }, unshift);
    });
  };

  /** 读取所有给定的字节，读完后放在buffer里。新建的任务将置于队列的【队尾】（先进先出） */
  public readBufferAfter: IRecvStreamReadBuffer = (readSize, callback) => {
    this.addNewTask({ type: "buffer", readSize, callback });
    return this;
  };

  /** 读取所有给定的字节，读完后放在buffer里。新建的任务将置于【队头】，保证它是下一个执行的（可多次调用，相当于栈，后进先出）*/
  public readBuffer: IRecvStreamReadBuffer = (readSize, callback) => {
    this.addNewTask({ type: "buffer", readSize, callback }, true);
    return this;
  };

  /** 建立“只读取给定的字节的”子可读流，并【立刻】返回该子读流的引用。新建的任务将置于【队尾】（先进先出） */
  public readStreamAfter: IRecvStreamReadStream = (readSize, callback, onClose) => {
    this.addNewTask({ type: "stream", readSize, callback, onClose });
    return this;
  };

  /** 建立“只读取给定的字节的”子可读流，并【立刻】返回该子读流的引用。新建的任务将置于【队头】，保证它是下一个执行的（可多次调用，相当于栈，后进先出）*/
  public readStream: IRecvStreamReadStream = (readSize, callback, onClose) => {
    this.addNewTask({ type: "stream", readSize, callback, onClose }, true);
    return this;
  };

  private addNewTask(recvStreamQueue: IRecvStreamQueue, unshift = false) {
    if (!recvStreamQueue.readSize) {
      if (recvStreamQueue.type === "buffer") {
        recvStreamQueue.callback(Buffer.alloc(0));
        return;
      }
      throw new Error("readSize 不能为0");
    }

    if (unshift) {
      this.taskQueue.unshift(recvStreamQueue);
    } else {
      this.taskQueue.push(recvStreamQueue);
    }
    this.newTask();
  }
}

export class SubReadStream extends stream.Readable {
  public sourceStream: IReadStream;
  public needReadSize: number;
  private tempBuffer?: Buffer;
  public done: (subReadStream: SubReadStream) => void;
  constructor(sourceStream: IReadStream, needReadSize: number, done?: (subReadStream: SubReadStream) => void) {
    super();
    this.sourceStream = sourceStream;
    this.needReadSize = needReadSize;
    this.done = done || (() => {});
    this.sourceStream.pause();
  }
  public _construct(callback: (err: TypeError | undefined) => void) {
    callback(this.sourceStream.destroyed ? new TypeError("stream destroyed") : undefined);
  }
  public consume() {
    while (this.tempBuffer && this.tempBuffer.length) {
      const nowRecvSize = Math.min(this.tempBuffer.length, this.needReadSize);
      this.push(this.tempBuffer.subarray(0, nowRecvSize));
      this.tempBuffer = nowRecvSize < this.tempBuffer.length ? this.tempBuffer.subarray(nowRecvSize) : undefined;
      this.needReadSize -= nowRecvSize;
      if (this.needReadSize <= 0) {
        this.sourceStream.unshift(this.tempBuffer);
        this.push(null);
        this.done(this);
        return true;
      }
    }

    return false;
  }
  public _read(canRecvSize: number) {
    if (this.consume()) {
      return;
    }
    if (!this.tempBuffer || !this.tempBuffer.length) {
      this.sourceStream.resume();
      this.sourceStream.once("data", chuck => {
        this.tempBuffer = chuck;
        this.sourceStream.pause();
        this.consume();
      });
    } else {
      throw new Error("不科学");
    }
  }
  public _destroy(err, callback) {
    callback(err);
  }
}

// 测试用例
// new SubReadStream(require("fs").createReadStream("d:/t.bin", { highWaterMark: 10 }), 64 * 1024 + 3, subReadStream => {
//   new SubReadStream(subReadStream.sourceStream, 64).pipe(require("fs").createWriteStream("3.bin"));
// }).pipe(require("fs").createWriteStream("2.bin"));

// 测试用例
// const recvStream = new RecvStream(require("fs").createReadStream("d:/t.bin", { highWaterMark: 10 }));
// recvStream.readBuffer(
//   byte => byte === 0x24,
//   buffer => {
//     console.log("不定长", buffer.length, [...buffer]);
//     recvStream.readBuffer(6, buffer => {
//       console.log(6, [...buffer]);
//     });
//     recvStream.readStream(100, stream1 => {
//       console.log(100, recvStream.sourceStream.readableFlowing);
//       stream1.pipe(require("fs").createWriteStream("1.bin"));
//     });
//   }
// );
// recvStream.readStream(10, stream1 => {
//   console.log(10);
//   // stream1.pipe(require("fs").createWriteStream("2.bin"));
//   stream1.on("data", d => {
//     console.log("data", d);
//   });
// });
// recvStream.readBufferAfter(6, buffer => {
//   console.log(6, [...buffer]);
// });
// recvStream.readBufferAfter(5, buffer => {
//   console.log(5, [...buffer]);
// });
// setTimeout(() => {}, 1000000);

// (async () => {
//   let i = 1024 * 10 + 2;
//   while (i--) {
//     const readBufferSync = recvStream.readBufferSync(2);
//     const buffer = readBufferSync instanceof Promise ? await readBufferSync : readBufferSync;
//     // console.log(buffer);
//   }
//   let times = 1000;
//   recvStream.readBuffer(
//     byte => byte === 0x24 && !--times,
//     buffer => {
//       console.log("不定长", buffer.length, [...buffer]);
//       recvStream.readBuffer(6, buffer => {
//         console.log(6, [...buffer]);
//       });
//       recvStream.readStream(100, stream1 => {
//         console.log(100, recvStream.sourceStream.readableFlowing);
//         stream1.pipe(require("fs").createWriteStream("1.bin"));
//       });
//     }
//   );
// })();
