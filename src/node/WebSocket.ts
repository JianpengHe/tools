import * as net from "net";
import * as http from "http";
import * as stream from "stream";
import * as crypto from "crypto";
import { RecvStream } from "./RecvStream";
//class TTT
export enum EWebSocketOpcode {
  "附加数据帧" = 0,
  "文本数据帧" = 1,
  "二进制数据帧" = 2,
  "连接关闭" = 8,
  "ping" = 9,
  "pong" = 10,
}
export class WebSocket extends stream.Duplex {
  public isWebSocket = false;
  private socket: net.Socket;
  private recvStream?: RecvStream;
  public opts: { onText?: (text: string) => void; maxTextSize?: number };
  constructor(req: http.IncomingMessage, res: http.ServerResponse, opts?: WebSocket["opts"]) {
    super();
    this.opts = opts || {};
    this.opts.maxTextSize = this.opts.maxTextSize ?? 64 * 1024 * 1024;
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
      this.canPushLen = 4;
      process.nextTick(() => {
        this.recvData();
      });
      this.socket.once("close", () => {
        this.push(null);
      });
    } else {
      this.push(null);
    }
  }
  /** 可以接受的长度 */
  private canPushLen?: number;
  /** 已解密的临时buffer */
  private recvBuffer: Buffer[] = [];
  private recvBufferLen = 0;
  /** 当前ws包的剩余大小 */
  private recvLen = 0;
  /** 当前ws包的类型 */
  private recvType = 0;
  /** 当前ws包是否已结束 */
  private recvIsEnd = true;
  /** 当前ws包的掩码 */
  private recvMask: number[] = [];
  /** 当前ws包掩码的序号 */
  private recvMaskIndex: number = 0;
  /** 接收函数上锁 */
  private recvlock = false;
  /** 接收浏览器传过来的数据 */
  private async recvData() {
    if (this.recvlock) {
      return;
    }
    this.recvlock = true;
    while (this.canPushLen) {
      if (!this.recvStream) {
        throw new Error("no recvStream");
      }
      if (this.recvLen === 0) {
        this.recvMaskIndex = 0;
        let needRead = 2;
        let readLen = false;
        let readMask = false;
        while (needRead) {
          const bufPo = this.recvStream.readBufferSync(needRead);
          const buffer = bufPo instanceof Promise ? await bufPo : bufPo;
          // console.log(buffer);
          if (readLen === false && readMask === false) {
            const flag = buffer[0];
            this.recvIsEnd = flag >= 128;
            this.recvType = flag % 128 || this.recvType;
            /** 如果接收到未知的opcode，接收端必须关闭连接 */
            if (EWebSocketOpcode[this.recvType] === undefined) {
              this.socket.end();
              this.emit("error", new Error("接收到未知的opcode"));
              return;
            }
            const len = buffer[1];
            if (len >= 128) {
              readMask = true;
            }
            switch (len % 128) {
              case 127:
                readLen = true;
                needRead = 8;
                break;
              case 126:
                readLen = true;
                needRead = 2;
                break;
              default:
                this.recvLen = len % 128;
                readLen = false;
                needRead = readMask ? 4 : 0;
            }
          } else if (readLen === true) {
            this.recvLen = [...buffer].reduce((a, b) => a * 256 + b);
            needRead = readMask ? 4 : 0;
            readLen = false;
          } else if (readMask === true) {
            this.recvMask = [...buffer];
            readMask = false;
            needRead = 0;
          }
        }
        if (this.recvType === EWebSocketOpcode["连接关闭"]) {
          this.socket.end();
          return;
        }
        // console.log("recvLen", this.recvLen, "recvType", this.recvType);
      }
      if (this.recvLen) {
        const bufPo = this.recvStream.readBufferSync(this.recvLen);
        const buf = bufPo instanceof Promise ? await bufPo : bufPo;
        /** 根据mask解密 */
        buf.forEach((a, i) => {
          buf[i] ^= this.recvMask[this.recvMaskIndex++];
          this.recvMaskIndex %= 4;
        });
        this.recvLen -= buf.length;
        this.recvBuffer.push(buf);
        this.recvBufferLen += buf.length;
        if (this.recvType === EWebSocketOpcode["文本数据帧"] && this.opts.onText && !this.recvIsEnd) {
          if (this.recvBufferLen > Number(this.opts.maxTextSize)) {
            this.emit(
              "error",
              new Error(
                "text too loog,maxTextSize" + Number(this.opts.maxTextSize) + ",nowRecvSize:" + this.recvBufferLen
              )
            );
            this.socket.end();
            return;
          }
          continue;
        }
        if (this.recvBuffer.length > 1) {
          this.recvBuffer[0] = Buffer.concat(this.recvBuffer);
          this.recvBuffer.length = 1;
        }
        const buffer = this.recvBuffer[0];
        this.recvBufferLen = 0;
        this.recvBuffer.length = 0;

        if (this.recvType === EWebSocketOpcode["文本数据帧"] && this.opts.onText) {
          this.opts.onText(String(buffer));
          this.canPushLen = 4;
        } else {
          this.push(buffer);
          this.canPushLen -= buffer.length;
          break;
        }
      }
    }
    this.recvlock = false;
  }
  /** 可以接收浏览器发过来多少数据 */
  async _read(len: number) {
    this.canPushLen = len;
    this.recvData();
  }

  _write(chunk, encoding, callback) {
    console.log(chunk);
    return false;
  }
}

// 测试用例
http
  .createServer((req, res) => {
    const t = new WebSocket(req, res, {
      onText(txt) {
        console.log("文字", txt);
      },
    });
    t.on("data", d => console.log("收到", d));
    t.on("end", () => {
      console.log("close");
    });
    t.on("error", e => {
      console.log(e);
    });
    t.isWebSocket || res.end("404");
  })
  .listen(80);
