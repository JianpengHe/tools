import * as dgram from "dgram";
import * as stream from "stream";
import * as fs from "fs";

export class ReliableUdp extends stream.Duplex {
  private sock: dgram.Socket;
  private ip: string;
  private port: number;
  constructor({ port, ip, sock }: { port: number; ip: string; sock?: dgram.Socket }) {
    super();
    this.ip = ip;
    this.port = port;
    this.sock = sock || dgram.createSocket("udp4");
    this.sock.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      //  console.log(msg);
      switch (msg[0]) {
        case 0:
          /** 心跳包 */
          break;
        case 1:
          /** 数据包 */
          this.readMap.set(msg.readUInt32LE(1), msg.subarray(7, 7 + msg.readUInt16LE(5)));
          this.readTryToRecv();
          break;
        case 2:
          /** 检验数据包 */
          this.writeRecvMap.get(msg.readUInt32LE(1))?.(msg.subarray(5));
          break;
      }
    });
  }
  /** 可以处理数据源的下一个数据块时的回调 */
  private writeCallback: (() => void) | null = null;
  /** 收到数据源的缓冲区 */
  private readonly writeBuffers: Buffer[] = [];
  /** 发送方序号 */
  private writeIndex = 0;
  /** 发送线程数 */
  private writeT = 10;
  /** 发送回调表 */
  private writeRecvMap: Map<number, (buffer: Buffer) => void> = new Map();
  private tryToWrite() {
    if (!this.writeT) return;
    const writeBuffer = this.writeBuffers.shift();
    if (!writeBuffer) {
      this.writeCallback && this.writeCallback();
      this.writeCallback = null;
      return;
    }
    this.writeT--;
    const index = writeBuffer.readUInt32LE(1);
    this.writeRecvMap.set(index, buffer => {
      // todo: 检验
      this.writeRecvMap.delete(index);
      this.writeT++;
      this.tryToWrite();
    });
    this.sock.send(writeBuffer, this.port, this.ip, err => {
      if (err) {
        console.log(err);
        throw err;
      }
    });
    this.tryToWrite();
  }
  _write(buffer: Buffer, encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void): void {
    if (this.writeCallback) {
      callback(new Error("急啥啊"));
      console.log("上一个还没处理完");
      return;
    }
    this.writeCallback = callback;
    for (let p = 0; p < buffer.length; ) {
      const chuck = buffer.subarray(p, (p += 512));
      const headBuffer = Buffer.allocUnsafe(1 + 4 + 2);
      /** 控制编号 */
      headBuffer[0] = 1;
      /** 序号 */
      headBuffer.writeUInt32LE(this.writeIndex % 4294967296, 1);
      this.writeIndex++;
      /** 长度 */
      headBuffer.writeUInt16LE(chuck.length, 5);
      this.writeBuffers.push(Buffer.concat([headBuffer, chuck]));
    }
    this.tryToWrite();
  }
  _read(size: number): void {
    // console.log("r", size);
    this.readTryToRecv();
  }
  private readIndex = 0;
  private readMap: Map<number, Buffer> = new Map();
  private readTryToRecv() {
    const buffer = this.readMap.get(this.readIndex);
    // console.log("read", buffer);
    if (!buffer) return;
    this.readMap.delete(this.readIndex);
    const headBuffer = Buffer.allocUnsafe(1 + 4 + 2);
    /** 控制编号 */
    headBuffer[0] = 2;
    /** 序号 */
    headBuffer.writeUInt32LE(this.readIndex, 1);
    /** 长度 */
    headBuffer.writeUInt16LE(buffer.length, 5);

    this.readIndex++;
    this.readIndex %= 4294967296;
    this.push(buffer);
    // console.log("headBuffer", headBuffer);
    this.sock.send(headBuffer, this.port, this.ip, err => {
      if (err) {
        console.log(err);
        throw err;
      }
    });
  }
}

// 测试用例
// const sock2 = dgram.createSocket("udp4");
// sock2.bind(11112);
// fs.createReadStream("Mysql.js").pipe(new ReliableUdp({ port: 11111, ip: "127.0.0.1", sock: sock2 }));

// const sock = dgram.createSocket("udp4");
// sock.bind(11111);

// new ReliableUdp({ port: 11112, ip: "127.0.0.1", sock }).pipe(fs.createWriteStream("Mysql1.js"));
