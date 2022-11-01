import * as stream from "stream";
import { IReadStream } from "./IReadStream";
export type IReadBufferFn = (readLength: number) => SubReadStream;
export type IGetLengthFn = (headerBuf: Buffer, readBufferFn: IReadBufferFn) => void;
export class RecvStream {
  public stream: IReadStream;
  public headerSize: number;
  public getLengthFn: IGetLengthFn;
  private subReadStream?: SubReadStream;
  constructor(stream: IReadStream, headerSize: number, getLengthFn: IGetLengthFn) {
    this.stream = stream;
    this.headerSize = headerSize;
    this.getLengthFn = getLengthFn;
    stream.on("readable", () => this.readable());
  }
  private readable() {
    if (!this.stream.readable) {
      return;
    }
    if (this.subReadStream) {
      this.subReadStream.tryRead();
      return;
    }
    this.readHeader();
  }
  private readHeader() {
    const header = this.stream.read(this.headerSize);
    if (!header) {
      return;
    }
    this.getLengthFn(header, (readLength: number) => {
      if (this.subReadStream) {
        throw new TypeError("只能调用一次");
      }
      this.subReadStream = new SubReadStream(this.stream, readLength, () => {
        this.subReadStream = undefined;
        this.readable();
      });
      return this.subReadStream;
    });
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
