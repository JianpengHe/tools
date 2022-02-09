import { Readable, Duplex } from "stream";
export type IReadStream = Readable | Duplex;
export type IReadBufferFn = (readLength: number) => SubReadStream;
export type IGetLengthFn = (headerBuf: Buffer, readBufferFn: IReadBufferFn) => void;
export const RecvAll = (stream: IReadStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const body: Buffer[] = [];
    stream.on("data", chuck => body.push(chuck));
    stream.once("end", () => resolve(Buffer.concat(body)));
    stream.once("error", reject);
  });
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
      this.readSubData();
    } else {
      this.readHeader();
    }
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
      this.subReadStream = new SubReadStream(this.stream, readLength);
      process.nextTick(() => this.readable());
      return this.subReadStream;
    });
  }
  private readSubData() {
    if (this.subReadStream && this.subReadStream._read(null) !== 0) {
      return;
    }
    this.subReadStream = undefined;
    this.readable();
  }
}

export class SubReadStream extends Readable {
  public stream: IReadStream;
  public lastTimeReadSize: number;
  public needReadSize: number;
  constructor(stream: IReadStream, needReadSize: number) {
    super();
    this.lastTimeReadSize = 0;
    this.stream = stream;
    this.needReadSize = needReadSize;
  }
  public _construct(callback: (err: TypeError | undefined) => void) {
    callback(this.stream.destroyed ? new TypeError("stream destroyed") : undefined);
  }
  public _read(size: number | null) {
    if (size) {
      this.lastTimeReadSize = Math.min(size, this.needReadSize);
    }
    if (this.lastTimeReadSize) {
      const buf = this.stream.read(this.lastTimeReadSize);
      if (buf) {
        this.push(buf);
        this.lastTimeReadSize = 0;
        this.needReadSize -= buf.length;
      }
    }
    if (this.needReadSize === 0) {
      this.push(null);
    }
    return this.needReadSize;
  }
  public _destroy(err, callback) {
    callback(err);
  }
}
