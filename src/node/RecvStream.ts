// 导入Node.js的stream模块，用于处理流数据
import * as stream from "stream";
// 导入自定义的IReadStream接口，定义了可读流的基本结构
import { IReadStream } from "./utils";

// 定义读取缓冲区的函数类型，可以指定固定大小或通过判断函数确定读取长度
export type IRecvStreamReadBuffer = (
  // 读取大小：可以是固定数字或根据字节内容判断的函数
  readSize: number | ((byte: number) => boolean),
  // 回调函数，接收读取到的缓冲区
  callback: (buffer?: Buffer) => void,
) => void;

// 定义读取流的函数类型，创建子流并通过回调返回
export type IRecvStreamReadStream = (
  // 读取的字节数
  readSize: number,
  // 回调函数，接收创建的子流
  callback: (stream?: SubReadStream) => void,
  // 可选的关闭回调函数
  onClose?: () => void,
) => void;

// 定义缓冲区任务队列项的类型，用于处理缓冲区读取请求
type IRecvStreamQueueBuffer = {
  // 类型标识为"buffer"，表示这是一个缓冲区读取任务
  type: "buffer";
  // 读取大小：固定数字或判断函数
  readSize: number | ((byte: number) => boolean);
  // 完成回调函数
  callback: Parameters<IRecvStreamReadBuffer>[1];
};

// 定义流任务队列项的类型，用于处理流读取请求
type IRecvStreamQueueStream = {
  // 类型标识为"stream"，表示这是一个流读取任务
  type: "stream";
  // 读取的字节数
  readSize: number;
  // 完成回调函数
  callback: Parameters<IRecvStreamReadStream>[1];
  // 可选的关闭回调函数
  onClose?: () => void;
};

// 任务队列项类型，可以是缓冲区任务或流任务
type IRecvStreamQueue = IRecvStreamQueueBuffer | IRecvStreamQueueStream;

// RecvStream类：用于管理数据流的读取，支持缓冲区和子流两种读取方式
export class RecvStream {
  /** 源可读流 */
  public sourceStream: IReadStream;

  /** 临时储存缓冲区数组，用于存放读取到的数据块 */
  private tempBuffer: Buffer[] = [];

  /** 临时储存的总字节数 */
  private tempBufferSize: number = 0;

  /** 剩余未接受的字节数，表示当前任务还需要读取的数据量 */
  private bufferRemainSize: number = 0;

  /** 不定长buffer的长度，用于跟踪使用判断函数确定长度时已读取的字节数 */
  private bufferLen: number = 0;

  /** 读取任务队列，存储待处理的读取请求 */
  private taskQueue: IRecvStreamQueue[] = [];

  /** 当前正在处理的任务 */
  private task?: IRecvStreamQueue;

  /**
   * 开始处理新任务
   * 从队列中取出一个任务并开始处理
   */
  private newTask() {
    if (
      this.task || // 已有正在执行的任务
      this.taskQueue.length === 0 || // 队列为空
      !(this.task = this.taskQueue.splice(0, 1)[0]) // 无法取出第一个任务
    ) {
      // 没有可执行的任务，直接返回
      // console.log("等待任务");
      return;
    }

    // 根据任务类型执行不同的处理逻辑
    if (this.task.type === "buffer") {
      // 缓冲区读取任务
      // 重置不定长buffer计数器
      this.bufferLen = 0;
      // 设置需要读取的字节数，如果是函数判断，至少读取1个字节
      this.bufferRemainSize = Number(this.task.readSize) || 1;
      // 开始读取数据
      this.read();
    } else {
      // 流读取任务
      // 暂停源流，防止数据继续流入
      this.sourceStream.pause();

      // 将已读取的数据退回源流，以便子流可以从头开始读取
      this.sourceStream.unshift(Buffer.concat(this.tempBuffer));

      // 清空临时缓冲区
      this.tempBuffer.length = 0;
      this.tempBufferSize = 0;

      // 创建子流并通过回调返回
      this.task.callback(
        new SubReadStream(this.sourceStream, this.task.readSize, () => {
          // 子流读取完成后的回调
          const task = this.task as IRecvStreamQueueStream;
          // 如果有关闭回调，执行它
          if (task.onClose) {
            task.onClose();
          }
          // 清除当前任务
          this.task = undefined;
          // 处理下一个任务
          this.newTask();
        }),
      );
    }
  }

  /**
   * 读取数据的核心方法
   * 处理缓冲区类型的读取请求
   */
  private read() {
    // console.log("read", this.bufferRemainSize, this.tempBufferSize, this.task);

    // 检查是否已读取足够的数据
    if (this.bufferRemainSize > this.tempBufferSize) {
      // 数据不足，需要继续从源流读取
      if (!this.sourceStream.readableFlowing) {
        // 如果源流已暂停，恢复它以继续接收数据
        this.sourceStream.resume();
      }

      // 监听源流的data事件，获取新数据
      this.sourceStream.once("data", chuck => {
        // 更新临时缓冲区大小
        this.tempBufferSize += chuck.length;
        // 将新数据块添加到临时缓冲区
        this.tempBuffer.push(chuck);
        // 递归调用read继续处理
        this.read();
      });
      return;
    }

    // 已读取足够的数据，处理当前任务

    // 合并临时缓冲区中的所有数据块为一个大缓冲区
    if (this.tempBuffer.length > 0) {
      this.tempBuffer[0] = Buffer.concat([...this.tempBuffer]);
      // 保留合并后的缓冲区
      // this.tempBuffer.length = 1;
    }

    // 获取合并后的缓冲区
    const buffer = this.tempBuffer[0];

    // 处理当前任务
    if (this.task) {
      const task = this.task as IRecvStreamQueueBuffer;
      // console.log("this.tempBuffer", this.tempBuffer);

      // 处理使用判断函数确定长度的情况
      if (task.readSize instanceof Function) {
        // 遍历最后一个数据块中的每个字节
        for (const byte of this.tempBuffer[this.tempBuffer.length - 1]) {
          // 增加已处理字节计数
          this.bufferLen++;
          this.bufferRemainSize++;
          // 调用判断函数检查是否满足条件
          if (task.readSize(byte)) {
            // 找到满足条件的字节，设置读取大小为当前长度
            task.readSize = this.bufferLen;
            break;
          }
        }

        // 清理临时缓冲区，只保留合并后的数据
        this.tempBuffer.length = 1;

        // 如果仍然是函数，说明还没找到满足条件的字节，继续读取
        if (task.readSize instanceof Function) {
          this.read();
          return;
        }
      } else {
        // 固定长度读取，清理临时缓冲区
        this.tempBuffer.length = 1;
      }

      // 调用回调函数，返回读取到的数据
      task.callback(buffer.subarray(0, task.readSize));
      // 更新临时缓冲区大小
      this.tempBufferSize -= task.readSize;
      // 更新临时缓冲区，移除已处理的数据
      this.tempBuffer[0] = buffer.subarray(task.readSize);
      // 清除当前任务
      this.task = undefined;
    }

    // 检查是否有更多任务需要处理
    if (this.taskQueue.length) {
      // 处理下一个任务
      this.newTask();
    } else {
      // 没有更多任务，暂停源流以节省资源
      this.sourceStream.pause();
    }
  }

  /**
   * 构造函数
   * @param sourceStream 源可读流
   */
  constructor(sourceStream: IReadStream) {
    // 保存源流引用
    this.sourceStream = sourceStream;
    // 初始暂停源流，等待读取请求
    sourceStream.pause();
    // 监听源流的关闭事件
    sourceStream.once("close", () => {
      // 源流关闭时，清空所有等待任务并返回undefined
      while (this.task) {
        this.task.callback(undefined);
        this.task = this.taskQueue.pop();
      }
    });
  }

  /**
   * readBuffer的"同步"写法
   * 尝试同步读取数据，如果数据不足则返回Promise
   * @param readSize 读取大小或判断函数
   * @param unshift 是否将任务添加到队列头部
   * @returns 读取到的数据或Promise
   */
  public readBufferSync: (
    readSize: number | ((byte: number) => boolean),
    unshift?: boolean,
  ) => Promise<Buffer | undefined> | Buffer = (readSize, unshift = false) => {
    // 合并临时缓冲区中的所有数据块
    if (this.tempBuffer.length > 0) {
      this.tempBuffer[0] = Buffer.concat([...this.tempBuffer]);
      this.tempBuffer.length = 1;
    }

    // 获取合并后的缓冲区
    const buffer = this.tempBuffer[0];

    // 处理使用判断函数确定长度的情况
    if (buffer && readSize instanceof Function) {
      // 查找满足条件的字节位置
      const index = buffer.findIndex(readSize);
      if (index > 0) {
        // 找到满足条件的字节，设置读取大小为该位置
        readSize = index;
      }
    }

    // console.log("readBufferSync", readSize);

    // 检查是否有足够的数据可以同步返回
    if (buffer && !(readSize instanceof Function) && this.tempBufferSize >= readSize) {
      // 更新临时缓冲区，移除已处理的数据
      this.tempBuffer[0] = buffer.subarray(readSize);
      this.tempBufferSize = this.tempBuffer[0].length;
      // 返回读取到的数据
      return buffer.subarray(0, readSize);
    }

    // 数据不足，返回Promise
    return new Promise(resolve => {
      // 添加新任务到队列
      this.addNewTask({ type: "buffer", readSize, callback: resolve }, unshift);
    });
  };

  /**
   * 读取所有给定的字节，读完后放在buffer里。新建的任务将置于队列的【队尾】（先进先出）
   * @param readSize 读取大小或判断函数
   * @param callback 完成回调函数
   * @returns this引用，支持链式调用
   */
  public readBufferAfter: IRecvStreamReadBuffer = (readSize, callback) => {
    // 添加新任务到队列尾部
    this.addNewTask({ type: "buffer", readSize, callback });
    return this;
  };

  /**
   * 读取所有给定的字节，读完后放在buffer里。新建的任务将置于【队头】，保证它是下一个执行的（可多次调用，相当于栈，后进先出）
   * @param readSize 读取大小或判断函数
   * @param callback 完成回调函数
   * @returns this引用，支持链式调用
   */
  public readBuffer: IRecvStreamReadBuffer = (readSize, callback) => {
    // 添加新任务到队列头部
    this.addNewTask({ type: "buffer", readSize, callback }, true);
    return this;
  };

  /**
   * 建立"只读取给定的字节的"子可读流，并【立刻】返回该子读流的引用。新建的任务将置于【队尾】（先进先出）
   * @param readSize 读取大小
   * @param callback 完成回调函数
   * @param onClose 关闭回调函数
   * @returns this引用，支持链式调用
   */
  public readStreamAfter: IRecvStreamReadStream = (readSize, callback, onClose) => {
    // 添加新任务到队列尾部
    this.addNewTask({ type: "stream", readSize, callback, onClose });
    return this;
  };

  /**
   * 建立"只读取给定的字节的"子可读流，并【立刻】返回该子读流的引用。新建的任务将置于【队头】，保证它是下一个执行的（可多次调用，相当于栈，后进先出）
   * @param readSize 读取大小
   * @param callback 完成回调函数
   * @param onClose 关闭回调函数
   * @returns this引用，支持链式调用
   */
  public readStream: IRecvStreamReadStream = (readSize, callback, onClose) => {
    // 添加新任务到队列头部
    this.addNewTask({ type: "stream", readSize, callback, onClose }, true);
    return this;
  };

  /**
   * 添加新任务到队列
   * @param recvStreamQueue 任务对象
   * @param unshift 是否添加到队列头部
   */
  private addNewTask(recvStreamQueue: IRecvStreamQueue, unshift = false) {
    // 检查读取大小是否有效
    if (!recvStreamQueue.readSize) {
      if (recvStreamQueue.type === "buffer") {
        // 读取大小为0的缓冲区任务，直接返回空缓冲区
        // console.log("返回空");
        recvStreamQueue.callback(Buffer.alloc(0));
        return;
      }
      // 读取大小为0的流任务，抛出错误
      throw new Error("ReadSize cannot be 0"); // readSize 不能为0
    }

    // 根据unshift参数决定将任务添加到队列头部还是尾部
    if (unshift) {
      this.taskQueue.unshift(recvStreamQueue);
    } else {
      this.taskQueue.push(recvStreamQueue);
    }

    // 尝试开始处理新任务
    this.newTask();
  }
}

/**
 * SubReadStream类：从源流中读取指定大小的数据并创建新的可读流
 * 继承自Node.js的Readable流
 */
export class SubReadStream extends stream.Readable {
  // 源可读流
  public sourceStream: IReadStream;
  // 需要读取的字节数
  public needReadSize: number;
  // 临时缓冲区，用于存储从源流读取的数据
  private tempBuffer?: Buffer;
  // 完成回调函数，在子流读取完成时调用
  public done: (subReadStream: SubReadStream) => void;

  /**
   * 构造函数
   * @param sourceStream 源可读流
   * @param needReadSize 需要读取的字节数
   * @param done 完成回调函数
   */
  constructor(sourceStream: IReadStream, needReadSize: number, done?: (subReadStream: SubReadStream) => void) {
    // 调用父类构造函数
    super();
    // 保存源流引用
    this.sourceStream = sourceStream;
    // 设置需要读取的字节数
    this.needReadSize = needReadSize;
    // 设置完成回调函数，如果没有提供则使用空函数
    this.done = done || (() => {});
    // 暂停源流，等待子流开始读取
    this.sourceStream.pause();
  }

  /**
   * 初始化流
   * @param callback 完成回调函数
   */
  public _construct(callback: (err: TypeError | undefined) => void) {
    // 检查源流是否已销毁，如果已销毁则返回错误
    callback(this.sourceStream.destroyed ? new TypeError("stream destroyed") : undefined);
  }

  /**
   * 消费临时缓冲区中的数据
   * @returns 是否完成了所有数据的读取
   */
  public consume() {
    // 检查临时缓冲区是否存在且有数据
    while (this.tempBuffer && this.tempBuffer.length) {
      // 计算本次可以读取的字节数
      const nowRecvSize = Math.min(this.tempBuffer.length, this.needReadSize);
      // 将数据推送到可读流
      this.push(this.tempBuffer.subarray(0, nowRecvSize));
      // 更新临时缓冲区，移除已处理的数据
      this.tempBuffer = nowRecvSize < this.tempBuffer.length ? this.tempBuffer.subarray(nowRecvSize) : undefined;
      // 减少需要读取的字节数
      this.needReadSize -= nowRecvSize;

      // 检查是否已读取完所有需要的数据
      if (this.needReadSize <= 0) {
        // 将剩余数据退回源流
        this.sourceStream.unshift(this.tempBuffer);
        // 推送null表示流结束
        this.push(null);
        // 调用完成回调函数
        this.done(this);
        return true;
      }
    }

    // 还有数据需要读取
    return false;
  }

  /**
   * Readable流的_read方法，当流需要更多数据时调用
   * @param canRecvSize 建议的读取大小（实际未使用）
   */
  public _read(canRecvSize: number) {
    // 尝试消费临时缓冲区中的数据
    if (this.consume()) {
      // 已完成所有数据的读取
      return;
    }

    // 需要从源流读取更多数据
    if (!this.tempBuffer || !this.tempBuffer.length) {
      // 恢复源流以接收数据
      this.sourceStream.resume();
      // 监听源流的data事件，获取新数据
      this.sourceStream.once("data", chuck => {
        // 保存新数据到临时缓冲区
        this.tempBuffer = chuck;
        // 暂停源流
        this.sourceStream.pause();
        // 尝试消费新数据
        this.consume();
      });
    } else {
      // 临时缓冲区有数据但consume返回false，这是不可能的情况
      throw new Error("It's impossible to see here"); // 不科学
    }
  }

  /**
   * 销毁流
   * @param err 错误对象
   * @param callback 完成回调函数
   */
  public _destroy(err, callback) {
    // 调用回调函数，传递错误对象
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
