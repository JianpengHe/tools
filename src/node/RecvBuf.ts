import { IReadStream } from "./IReadStream";
export const recvAll = (stream: IReadStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const body: Buffer[] = [];
    stream.on("data", chuck => body.push(chuck));
    stream.once("end", () => resolve(Buffer.concat(body)));
    stream.once("error", reject);
  });
type IRecvQueue = {
  needSize: number;
  notError: boolean;
  resolve: (buf: Buffer) => void;
  reject: (reason?: Error) => void;
};
export class RecvBuf {
  public stream: IReadStream;
  /** 需要读取的字节 */
  private needReadByte = 0;
  public recvBufs: Buffer[] = [];
  private tryRead() {
    if (!this.stream || !this.recvQueue.length || !this.stream.readable) {
      return;
    }
    if (this.stream.isPaused()) {
      this.stream.resume();
    }
    const { needSize, resolve } = this.recvQueue[0];
    if (!this.needReadByte) {
      this.needReadByte = needSize;
    }
    if (this.stream.readableLength && this.needReadByte) {
      const buf: Buffer = this.stream.read(Math.min(this.stream.readableLength, this.needReadByte));
      this.recvBufs.push(buf);
      this.needReadByte -= buf.length;
    }
    if (!this.needReadByte) {
      resolve(Buffer.concat(this.recvBufs));
      this.recvBufs.length = 0;
      this.recvQueue.shift();
      this.tryRead();
    }
  }
  private close() {
    let recvQuery: IRecvQueue;
    while ((recvQuery = (this.recvQueue.splice(0, 1) || [])[0])) {
      if (recvQuery.notError) {
        recvQuery.resolve(Buffer.alloc(0));
      } else {
        recvQuery.reject(new Error("流已关闭，但字节数尚未满足"));
      }
    }
  }
  constructor(stream: IReadStream, onError?: (err: any) => void) {
    this.stream = stream;
    stream.on("readable", () => this.tryRead());
    stream.on("error", onError ?? (() => {}));
    stream.on("end", () => this.close());
    stream.on("close", () => this.close());
  }

  public recvQueue: IRecvQueue[] = [];
  public recv(byte: number, notError?: boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!byte) {
        resolve(Buffer.alloc(0));
        return;
      }
      this.recvQueue.push({ needSize: byte, notError: !!notError, resolve, reject });
      this.tryRead();
    });
  }
  public recvCallback(byte: number, callbackFn: (err: Error | null, buf: Buffer) => void) {
    if (!byte) {
      callbackFn(null, Buffer.alloc(0));
      return;
    }
    this.recvQueue.push({
      needSize: byte,
      notError: false,
      resolve(buf) {
        callbackFn(null, buf);
      },
      reject(reason) {
        callbackFn(reason ?? null, Buffer.alloc(0));
      },
    });
    this.tryRead();
    return this;
  }
}
