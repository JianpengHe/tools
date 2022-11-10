import * as stream from "stream";
import { IReadStream } from "./utils";

export type IRecvStreamReadBuffer = (readSize: number, callback: (buffer: Buffer) => void) => void;
export type IRecvStreamReadStream = (
  readSize: number,
  callback: (stream: SubReadStream) => void,
  onClose?: () => void
) => void;

type IRecvStreamQueue =
  | { type: "buffer"; readSize: number; callback: Parameters<IRecvStreamReadBuffer>[1] }
  | { type: "stream"; readSize: number; callback: Parameters<IRecvStreamReadStream>[1]; onClose?: () => void };
export class RecvStream {
  /** 源可读流 */
  public stream: IReadStream;

  /** 只读取一定字节的子可读流引用，会立刻交付给callback回调函数 */
  private subReadStream?: SubReadStream;

  /** 只读取一定字节的buffer引用，会接收完后，才交付给callback回调函数 */
  private subBuffer: Buffer[] = [];

  /** 剩余未接受的字节数 */
  private subBufferRemainSize: number = 0;

  /** read函数队列 */
  private taskQueue: IRecvStreamQueue[] = [];

  /** 当前是否正在处理 */
  private taskLock: boolean = false;

  /** callback函数是否正在执行 */
  private isCallbaclRun: boolean = false;

  constructor(stream: IReadStream) {
    this.stream = stream;
    stream.on("readable", this.readable.bind(this));
    // stream.on("end", () => {
    //   console.log("p");
    // });
  }
  private readable() {
    // console.log(this.stream.readable, this.taskQueue);
    const nowFn = this.taskQueue[0];
    if (!this.stream.readable || !nowFn) {
      return;
    }

    if (nowFn.type === "stream") {
      if (!this.taskLock || !this.subReadStream) {
        if (this.taskLock && !this.subReadStream) {
          return;
        }
        this.taskLock = true;
        this.subReadStream = new SubReadStream(this.stream, nowFn.readSize, () => {
          this.subReadStream = undefined;
          if (nowFn.onClose) {
            this.isCallbaclRun = true;
            nowFn.onClose();
            this.isCallbaclRun = false;
          }
          this.taskDone();
        });
        this.isCallbaclRun = true;
        nowFn.callback(this.subReadStream);
        this.isCallbaclRun = false;
      }
      this.subReadStream.tryRead();
      return;
    }

    if (!this.taskLock) {
      this.taskLock = true;
      this.subBuffer.length = 0;
      this.subBufferRemainSize = nowFn.readSize;
    }
    this.tryRead();
  }
  private tryRead() {
    // console.log(this.subBufferRemainSize, this.stream.readableLength, this.stream.readable);
    if (this.subBufferRemainSize && this.stream.readableLength) {
      const buf = this.stream.read(Math.min(this.subBufferRemainSize, this.stream.readableLength));
      if (!buf) {
        return;
      }
      // console.log(buf.length);
      this.subBuffer.push(buf);
      this.subBufferRemainSize -= buf.length;
      if (!this.subBufferRemainSize) {
        const nowFn = this.taskQueue[0];
        if (nowFn.type !== "stream") {
          this.isCallbaclRun = true;
          nowFn.callback(Buffer.concat(this.subBuffer));
          this.isCallbaclRun = false;
          this.subBuffer.length = 0;
          this.taskDone();
          return;
        }
        throw new Error("不可能到这里的");
      } else {
        this.tryRead();
      }
    }
  }

  /** 上一个任务完成后 */
  private taskDone() {
    this.stream.resume();
    this.taskLock = false;
    this.taskQueue.splice(0, 1);
    this.readable();
  }

  /** 读取所有给定的字节，读完后放在buffer里。若在callback里调用该函数，新建的任务将置于队头，保证它是下一个执行的（可多次调用，相当于栈，后进先出），若在其他地方调用则置于队尾（先进先出） */
  public readBuffer: IRecvStreamReadBuffer = (readSize, callback) => {
    this.newTask({ type: "buffer", readSize, callback });
    return this;
  };

  /** 建立“只读取给定的字节的”子可读流，并【立刻】返回该子读流的引用。若在callback/onClose里调用该函数，新建的任务将置于队头，保证它是下一个执行的（可多次调用，相当于栈，后进先出），若在其他地方调用则置于队尾（先进先出） */
  public readStream: IRecvStreamReadStream = (readSize, callback, onClose) => {
    this.newTask({ type: "stream", readSize, callback, onClose });
    return this;
  };

  /** 新建task */
  private newTask(recvStreamQueue: IRecvStreamQueue) {
    if (!recvStreamQueue.readSize) {
      if (recvStreamQueue.type === "buffer") {
        recvStreamQueue.callback(Buffer.alloc(0));
        return;
      }
      throw new Error("readSize 不能为0");
    }
    if (this.isCallbaclRun) {
      this.taskQueue.splice(1, 0, recvStreamQueue);
    } else {
      this.taskQueue.push(recvStreamQueue);
    }
    this.stream.resume();
    this.readable();
  }
}

export class SubReadStream extends stream.Readable {
  public stream: IReadStream;
  public canRecvSize: number;
  public needReadSize: number;
  public done: () => void;
  constructor(stream: IReadStream, needReadSize: number, done: () => void) {
    super();
    this.canRecvSize = 0;
    this.stream = stream;
    this.needReadSize = needReadSize;
    this.done = done;
  }
  public _construct(callback: (err: TypeError | undefined) => void) {
    callback(this.stream.destroyed ? new TypeError("stream destroyed") : undefined);
  }
  public tryRead() {
    if (!this.needReadSize) {
      this.push(null);
      this.done();
      return;
    }
    const nowNeedRead = Math.min(this.canRecvSize, this.stream.readableLength, this.needReadSize);
    if (nowNeedRead === 0) {
      return;
    }
    const buf = this.stream.read(nowNeedRead);
    if (buf) {
      this.push(buf);
      this.needReadSize -= buf.length;
      this.canRecvSize -= buf.length;
      this.tryRead();
    }
  }
  public _read(canRecvSize: number) {
    this.canRecvSize = canRecvSize || 0;
    this.tryRead();
  }
  public _destroy(err, callback) {
    callback(err);
  }
}

// 测试用例
// https://updatecdn.meeting.qq.com/cos/6e6d1d9c19084cc66193dbe807c9ab0c/TencentMeeting_0300000000_3.12.7.434.publish.exe
// require("https").get(
//   "https://updatecdn.meeting.qq.com/cos/6e6d1d9c19084cc66193dbe807c9ab0c/TencentMeeting_0300000000_3.12.7.434.publish.exe",
//   res => {
//     const recvStream = new RecvStream(res);
//     recvStream.readBuffer(1e10, buffer => {
//       console.log(buffer);
//       recvStream.readStream(
//         2,
//         stream => {
//           console.log(2);
//           stream.pipe(require("fs").createWriteStream("1.bin"));
//           recvStream.readBuffer(7, buffer => {
//             console.log(7, buffer);
//           });
//         },
//         () => {
//           console.log("sub stream close");
//           recvStream.readStream(6, stream => {
//             console.log(6);
//             stream.pipe(require("fs").createWriteStream("2.bin"));
//           });
//         }
//       );
//     });
//     recvStream.readBuffer(3, buffer => {
//       console.log(2, buffer);
//       recvStream.readBuffer(5, buffer => {
//         console.log(5, buffer);
//       });
//     });
//     recvStream.readBuffer(4, buffer => {
//       console.log(3, buffer);
//     });
//   }
// );
