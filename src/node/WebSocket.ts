import * as net from "net";
import * as http from "http";
import * as stream from "stream";
import * as crypto from "crypto";
import { RecvStream } from "./RecvStream";
import { TypedEventEmitter } from "./utils";
import { Buf } from "./Buf";
export enum EWebSocketOpcode {
  "附加数据帧" = 0,
  "文本数据帧" = 1,
  "二进制数据帧" = 2,
  "连接关闭" = 8,
  "ping" = 9,
  "pong" = 10,
}
export type IWebSocketEvents = {
  connected: () => void;
  subStream: (subStream: stream.Readable) => void;
  text: (text: string) => void;
  ping: (buffer: Buffer) => void;
  error: (err: Error) => void;
  close: () => void;
};

export class WebSocket extends TypedEventEmitter<IWebSocketEvents> {
  public isWebSocket = false;
  private socket: net.Socket;
  private recvStream?: RecvStream;
  public opts: { maxTextSize?: number; recvHighWaterMark?: number; sendHighWaterMark?: number };
  constructor(req: http.IncomingMessage, res: http.ServerResponse, opts?: WebSocket["opts"]) {
    super();
    this.opts = opts || {};
    this.opts.maxTextSize = this.opts.maxTextSize ?? 64 * 1024 * 1024;
    this.opts.recvHighWaterMark = this.opts.recvHighWaterMark ?? 65536;
    this.opts.sendHighWaterMark = this.opts.sendHighWaterMark ?? 65536;
    this.socket = req.socket;
    if (req.headers.connection === "Upgrade" && req.headers["sec-websocket-key"]) {
      res.writeHead(101, {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Accept": crypto
          .createHash("sha1")
          .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64"),
      });
      res.flushHeaders();
      this.recvStream = new RecvStream(this.socket);
      this.socket.resume();
      this.isWebSocket = true;
      process.nextTick(() => {
        this.emit("connected");
        this.recvData();
      });
      this.socket.once("close", () => this.emit("close"));
    } else {
      this.emit("close");
    }
  }
  /** 接收浏览器传过来的数据 */
  private async recvData() {
    /** 接收一个完整的ws包 */
    while (1) {
      let recvType: number = 0;
      let subReadable: stream.Readable | undefined;
      let canReadSize = Number(this.opts?.recvHighWaterMark);
      let canReadFn = (value: boolean) => {};
      let canReadPush: ((value: Buffer | null) => void) | undefined;
      const buffers: Buffer[] = [];
      let buffersLen: number = 0;
      while (1) {
        /** 接收一个ws分包 */
        if (!this.recvStream) {
          const err = new Error("no recvStream");
          if (!this.emit("error", err)) {
            throw err;
          }
          return;
        }

        /** 接收前2个字节 */
        const headBufPo = this.recvStream.readBufferSync(2);
        const headBuf = headBufPo instanceof Promise ? await headBufPo : headBufPo;
        const flag = headBuf[0];
        const recvIsEnd = flag >= 128;
        let needReadMask = false;
        let recvMask: number[] = [0, 0, 0, 0];
        let recvLen = 0;
        recvType = flag % 128 || recvType;
        if (!subReadable && recvType === 2) {
          subReadable = new stream.Readable({
            read(size) {
              if (!canReadPush) {
                canReadPush = this.push.bind(this);
              }
              // console.log("可以收");
              canReadSize = size;
              canReadFn(true);
              canReadFn = () => {};
            },
          });
          if (!this.emit("subStream", subReadable)) {
            console.warn("未添加subStream事件监听器，websocket的所有stream都会被丢弃");
            subReadable = undefined;
          }
        }

        /** 如果接收到未知的opcode，接收端必须关闭连接 */
        if (EWebSocketOpcode[recvType] === undefined) {
          this.socket.end();
          const err = new Error("接收到未知的opcode");
          if (!this.emit("error", err)) {
            throw err;
          }
          return;
        }
        if (recvType === EWebSocketOpcode["连接关闭"]) {
          this.socket.end();
          return;
        }

        recvLen = headBuf[1];
        if (recvLen >= 128) {
          needReadMask = true;
        }
        recvLen %= 128;
        if (recvLen > 125) {
          const lenBufPo = this.recvStream.readBufferSync(recvLen === 126 ? 2 : 8);
          recvLen = [...(lenBufPo instanceof Promise ? await lenBufPo : lenBufPo)].reduce((a, b) => a * 256 + b);
        }

        if (needReadMask) {
          const maskBufPo = this.recvStream.readBufferSync(4);
          recvMask = [...(maskBufPo instanceof Promise ? await maskBufPo : maskBufPo)];
        }
        // console.log("recvLen", recvLen, "recvType", recvType);
        if (!recvLen) {
          if (recvType === EWebSocketOpcode["ping"]) {
            this.emit("ping", Buffer.allocUnsafe(0));
            this.socket.write(Buffer.from([0x8a, 0]));
          }
          break;
        }
        let recvMaskIndex = 0;
        /** 再根据recvHighWaterMark大小分包 */
        while (recvLen > 0) {
          const nowReadSize = Math.min(canReadSize, recvLen, Number(this.opts?.recvHighWaterMark));

          if (nowReadSize <= 0 || (subReadable && !canReadPush)) {
            /** 等一等 */
            await new Promise(r => {
              canReadFn = r;
            });
            continue;
          }
          const bufPo = this.recvStream.readBufferSync(nowReadSize);
          const buf = bufPo instanceof Promise ? await bufPo : bufPo;
          buf.forEach((_, i) => {
            buf[i] ^= recvMask[recvMaskIndex++];
            recvMaskIndex %= 4;
          });
          recvLen -= buf.length;
          /** TODO */

          if (subReadable && canReadPush) {
            // console.log("发送", buf.length);
            canReadPush(buf);
            canReadSize = 0;
          } else if (recvType === EWebSocketOpcode["文本数据帧"]) {
            buffersLen += buf.length;
            buffers.push(buf);
            if (buffersLen > Number(this.opts.maxTextSize)) {
              const err = new Error(
                "text too loog,maxTextSize" + Number(this.opts.maxTextSize) + ",nowRecvSize:" + buffersLen
              );
              if (this.emit("error", err)) {
                throw err;
              }
              this.emit("close");
              this.socket.end();
              return;
            }
          } else if (recvType === EWebSocketOpcode["pong"]) {
            this.pingCallBacks.get(buf.readUInt32BE())?.();
          } else if (recvType === EWebSocketOpcode["ping"]) {
            this.emit("ping", buf);
            this.socket.write(Buffer.concat([Buffer.from([0x8a, buf.length]), buf]));
          }
        }
        if (recvIsEnd) {
          break;
        }
      }
      if (recvType === EWebSocketOpcode["二进制数据帧"] && canReadPush) {
        canReadPush(null);
        canReadSize = 0;
      } else if (recvType === EWebSocketOpcode["文本数据帧"]) {
        this.emit("text", String(Buffer.concat(buffers)));
      }

      // console.log("recvLen", this.recvLen, "recvType", this.recvType);
    }
  }
  private sendQueue: (Buffer | stream.Readable | string)[] = [];
  public sendBusy = false;
  public send(data: Buffer | stream.Readable | string) {
    this.sendQueue.push(data);
    this.tryToCleanQueue();
    return this;
  }

  private async tryToCleanQueue() {
    if (this.sendBusy || this.sendQueue.length === 0) {
      return;
    }
    this.sendBusy = true;
    const task = this.sendQueue.splice(0, 1)[0];
    let isStart = true;
    const makeHeadBuf = (type: number, len: number) => {
      const buf = new Buf();
      if (isStart) {
        buf.writeUIntBE(type, 1);
        isStart = false;
      } else {
        buf.writeUIntBE(0, 1);
      }
      if (len < 126) {
        buf.writeUIntBE(len, 1);
      } else if (len < 65536) {
        buf.writeUIntBE(126, 1).writeUIntBE(len, 2);
      } else {
        buf.writeUIntBE(127, 1).writeUIntBE(len, 8);
      }
      return buf;
    };
    if (task instanceof stream.Readable) {
      task.on("data", chunk => {
        if (!this.socket.write(Buffer.concat([makeHeadBuf(2, chunk.length).buffer, chunk]))) {
          task.pause();
          this.socket.once("drain", () => task.resume());
        }
      });
      task.on("end", () => {
        this.socket.write(Buffer.from([128, 0]));
        this.sendBusy = false;
        this.tryToCleanQueue();
      });
    } else {
      const isText = !(task instanceof Object);
      const dataBuf = new Buf(Buffer.from(task));
      while (dataBuf.offset < dataBuf.buffer.length) {
        const chunk = dataBuf.read(Number(this.opts.sendHighWaterMark));
        const buf = makeHeadBuf(isText ? 1 : 2, chunk.length);
        if (dataBuf.offset === dataBuf.buffer.length) {
          buf.buffer[0] += 128;
        }
        if (!this.socket.write(Buffer.concat([buf.buffer, chunk]))) {
          await new Promise(resolve => this.socket.once("drain", resolve));
        }
      }
      this.sendBusy = false;
      this.tryToCleanQueue();
    }
  }
  public ping = (timeout: number = 5000) =>
    new Promise((resolve, reject) => {
      let rand = 0;
      do {
        rand = ((Math.random() * 1e11) | 0) - (1 << 31);
      } while (this.pingCallBacks.has(rand));
      const timer = setTimeout(() => {
        if (this.pingCallBacks.has(rand)) {
          this.pingCallBacks.delete(rand);
          reject(new Error("timeout:" + timeout + "ms"));
          return;
        }
      }, timeout);
      this.pingCallBacks.set(rand, () => {
        clearTimeout(timer);
        this.pingCallBacks.delete(rand);
        resolve(new Date().getTime() - time);
      });
      const buf = new Buf();
      buf.writeUIntBE(0x89, 1);
      buf.writeUIntBE(4, 1);
      buf.writeUIntBE(rand, 4);
      this.socket.write(buf.buffer);
      const time = new Date().getTime();
    });
  private pingCallBacks: Map<number, () => void> = new Map();
}

// 测试用例
// http
//   .createServer((req, res) => {
//     const t = new WebSocket(req, res, {})
//       .on("subStream", subStream => {
//         subStream.on("data", c => console.log("收到", c));
//         subStream.on("end", () => console.log("结束"));
//         // subStream.pipe(require("fs").createWriteStream("ttt.bin"));
//       })
//       .on("text", txt => {
//         console.log("文字", txt);
//       })
//       .on("connected", () => {
//         t.send(require("fs").createReadStream("ttt.bin"));
//         // t.send("1234567890".repeat(1024 * 10));
//         // setTimeout(() => {
//         //t.ping().then(delay => console.log("与客户端延迟：", delay, "ms"));
//         // }, 500);
//       })
//       .on("ping", buf => console.log("ping", buf))
//       .on("error", e => {
//         console.log(e);
//       });
//     t.isWebSocket || res.end("404");
//   })
//   .listen(80);
