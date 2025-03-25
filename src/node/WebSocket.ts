import * as net from "net";
import * as http from "http";
import * as stream from "stream";
import * as crypto from "crypto";
import { RecvStream } from "./RecvStream";
import { TypedEventEmitter } from "./utils";
import { Buf } from "./Buf";

// 定义WebSocket操作码的枚举类型
export enum EWebSocketOpcode {
  "Continuation" = 0, // 表示数据帧是前一个数据帧的延续
  "Text" = 1, // 表示数据帧包含文本数据
  "Binary" = 2, // 表示数据帧包含二进制数据
  "Close" = 8, // 表示关闭连接的控制帧
  "Ping" = 9, // 表示Ping控制帧
  "Pong" = 10, // 表示Pong控制帧
}

// 定义WebSocket事件接口类型
export type IWebSocketEvents = {
  connected: () => void; // 连接建立时触发的事件
  subStream: (subStream: stream.Readable) => void; // 接收到子流时触发的事件
  text: (text: string) => void; // 接收到文本数据时触发的事件
  ping: (buffer: Buffer) => void; // 接收到Ping帧时触发的事件
  error: (err: Error) => void; // 发生错误时触发的事件
  close: () => void; // 连接关闭时触发的事件
};

// WebSocket类，继承自TypedEventEmitter，实现WebSocket协议
export class WebSocket extends TypedEventEmitter<IWebSocketEvents> {
  // 标识当前连接是否是WebSocket连接
  public isWebSocket = false;
  // 底层TCP套接字
  private socket: net.Socket;
  // 接收数据的流
  private recvStream?: RecvStream;
  // WebSocket选项配置
  public opts: { maxTextSize?: number; recvHighWaterMark?: number; sendHighWaterMark?: number };

  /**
   * 构造函数，初始化WebSocket连接
   * @param req HTTP请求对象
   * @param res HTTP响应对象
   * @param opts WebSocket选项配置
   */
  constructor(req: http.IncomingMessage, res: http.ServerResponse, opts?: WebSocket["opts"]) {
    super();
    // 初始化选项配置
    this.opts = opts || {};
    // 设置最大文本大小，默认为64MB
    this.opts.maxTextSize = this.opts.maxTextSize ?? 64 * 1024 * 1024;
    // 设置接收缓冲区大小，默认为64KB
    this.opts.recvHighWaterMark = this.opts.recvHighWaterMark ?? 65536;
    // 设置发送缓冲区大小，默认为64KB
    this.opts.sendHighWaterMark = this.opts.sendHighWaterMark ?? 65536;
    // 获取底层TCP套接字
    this.socket = req.socket;

    // 检查是否是WebSocket升级请求
    if (req.headers.connection === "Upgrade" && req.headers["sec-websocket-key"]) {
      // 发送101状态码，表示切换协议
      res.writeHead(101, {
        Upgrade: "websocket",
        Connection: "Upgrade",
        // 根据WebSocket协议计算Sec-WebSocket-Accept响应头
        "Sec-WebSocket-Accept": crypto
          .createHash("sha1")
          .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64"),
      });
      // 刷新响应头
      res.flushHeaders();
      // 创建接收数据的流
      this.recvStream = new RecvStream(this.socket);
      // 恢复套接字数据流
      this.socket.resume();
      // 标记为WebSocket连接
      this.isWebSocket = true;
      // 在下一个事件循环中触发connected事件并开始接收数据
      process.nextTick(() => {
        this.emit("connected");
        this.recvData();
      });
      // 监听套接字关闭事件
      this.socket.once("close", () => this.emit("close"));
    } else {
      // 如果不是WebSocket升级请求，触发关闭事件
      this.emit("close");
    }
  }

  /** 接收浏览器传过来的数据 */
  private async recvData() {
    /** 接收一个完整的ws包 */
    while (1) {
      // 接收类型，初始为0
      let recvType: number = 0;
      // 子可读流，用于处理二进制数据
      let subReadable: stream.Readable | undefined;
      // 可读取的大小
      let canReadSize = Number(this.opts?.recvHighWaterMark);
      // 可读取的回调函数
      let canReadFn = (value: boolean) => {};
      // 可读取推送函数
      let canReadPush: ((value: Buffer | null) => void) | undefined;
      // 存储接收到的缓冲区
      const buffers: Buffer[] = [];
      // 缓冲区总长度
      let buffersLen: number = 0;

      while (1) {
        /** 接收一个ws分包 */
        if (!this.recvStream) {
          // 如果没有接收流，创建错误并触发error事件
          const err = new Error("no recvStream");
          if (!this.emit("error", err)) {
            throw err;
          }
          return;
        }

        /** 接收前2个字节 */
        const headBufPo = this.recvStream.readBufferSync(2);
        // 处理同步或异步读取结果
        const headBuf = headBufPo instanceof Promise ? await headBufPo : headBufPo;
        if (!headBuf) {
          // 如果读取头部失败，关闭连接并抛出错误
          this.socket.end();
          throw new Error("读取头部失败");
        }
        // 解析标志位
        const flag = headBuf[0];
        // 判断是否是最后一个分片
        const recvIsEnd = flag >= 128;
        // 是否需要读取掩码
        let needReadMask = false;
        // 掩码数组，WebSocket客户端发送的数据必须使用掩码
        let recvMask: number[] = [0, 0, 0, 0];
        // 接收长度
        let recvLen = 0;
        // 获取操作码，如果是0则使用之前的操作码
        recvType = flag % 128 || recvType;

        // 如果是二进制数据且还没有创建子可读流，则创建一个
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
          // 触发subStream事件，如果没有监听器则丢弃数据
          if (!this.emit("subStream", subReadable)) {
            console.warn("Without adding a subStream event listener, all streams of websocket will be discarded!"); // 未添加subStream事件监听器，websocket的所有stream都会被丢弃
            subReadable = undefined;
          }
        }

        /** 如果接收到未知的opcode，接收端必须关闭连接 */
        if (EWebSocketOpcode[recvType] === undefined) {
          this.socket.end();
          const err = new Error("Received unknown opcode"); // 接收到未知的opcode
          if (!this.emit("error", err)) {
            throw err;
          }
          return;
        }

        // 如果接收到关闭帧，关闭连接并返回
        if (recvType === EWebSocketOpcode["Close"]) {
          this.socket.end();
          return;
        }

        // 解析数据长度
        recvLen = headBuf[1];
        // 检查是否有掩码
        if (recvLen >= 128) {
          needReadMask = true;
        }
        // 获取实际长度（去掉掩码标志位）
        recvLen %= 128;

        // 处理扩展长度
        if (recvLen > 125) {
          // 如果长度为126，读取2字节的长度；如果为127，读取8字节的长度
          const lenBufPo = this.recvStream.readBufferSync(recvLen === 126 ? 2 : 8);
          const lenBuffer = lenBufPo instanceof Promise ? await lenBufPo : lenBufPo;
          if (!lenBuffer) {
            // 如果读取长度失败，关闭连接并抛出错误
            this.socket.end();
            throw new Error("读取长度失败");
          }
          // 将字节数组转换为数字
          recvLen = [...lenBuffer].reduce((a, b) => a * 256 + b);
        }

        // 如果有掩码，读取掩码
        if (needReadMask) {
          const maskBufPo = this.recvStream.readBufferSync(4);
          const maskBuffer = maskBufPo instanceof Promise ? await maskBufPo : maskBufPo;
          if (!maskBuffer) {
            // 如果读取掩码失败，关闭连接并抛出错误
            this.socket.end();
            throw new Error("读取needReadMask失败");
          }
          // 将掩码缓冲区转换为数组
          recvMask = [...maskBuffer];
        }

        // 如果数据长度为0
        if (!recvLen) {
          // 如果是Ping帧，发送Pong响应
          if (recvType === EWebSocketOpcode["Ping"]) {
            this.emit("ping", Buffer.allocUnsafe(0));
            this.socket.write(Buffer.from([0x8a, 0]));
          }
          break;
        }

        // 掩码索引
        let recvMaskIndex = 0;
        /** 再根据recvHighWaterMark大小分包 */
        while (recvLen > 0) {
          // 计算本次读取的大小
          const nowReadSize = Math.min(canReadSize, recvLen, Number(this.opts?.recvHighWaterMark));

          // 如果无法读取，等待可读取
          if (nowReadSize <= 0 || (subReadable && !canReadPush)) {
            /** 等一等 */
            await new Promise(r => {
              canReadFn = r;
            });
            continue;
          }

          // 读取数据
          const bufPo = this.recvStream.readBufferSync(nowReadSize);
          const buf = bufPo instanceof Promise ? await bufPo : bufPo;
          if (!buf) {
            // 如果读取数据失败，关闭连接并抛出错误
            this.socket.end();
            throw new Error("读取body失败");
          }

          // 应用掩码
          buf.forEach((_, i) => {
            buf[i] ^= recvMask[recvMaskIndex++];
            recvMaskIndex %= 4;
          });

          // 减少剩余长度
          recvLen -= buf.length;

          // 根据不同的操作码处理数据
          if (subReadable && canReadPush) {
            // 如果是二进制数据且有子可读流，将数据推送到子流
            // console.log("发送", buf.length);
            canReadPush(buf);
            canReadSize = 0;
          } else if (recvType === EWebSocketOpcode["Text"]) {
            // 如果是文本数据，存储到缓冲区
            buffersLen += buf.length;
            buffers.push(buf);
            // 检查文本大小是否超过限制
            if (buffersLen > Number(this.opts.maxTextSize)) {
              const err = new Error(
                "text too loog,maxTextSize" + Number(this.opts.maxTextSize) + ",nowRecvSize:" + buffersLen,
              );
              if (this.emit("error", err)) {
                throw err;
              }
              this.emit("close");
              this.socket.end();
              return;
            }
          } else if (recvType === EWebSocketOpcode["Pong"]) {
            // 如果是Pong帧，调用对应的回调函数
            this.pingCallBacks.get(buf.readUInt32BE())?.();
          } else if (recvType === EWebSocketOpcode["Ping"]) {
            // 如果是Ping帧，发送Pong响应
            this.emit("ping", buf);
            this.socket.write(Buffer.concat([Buffer.from([0x8a, buf.length]), buf]));
          }
        }

        // 如果是最后一个分片，跳出循环
        if (recvIsEnd) {
          break;
        }
      }

      // 处理完整的数据帧
      if (recvType === EWebSocketOpcode["Binary"] && canReadPush) {
        // 如果是二进制数据，发送null表示结束
        canReadPush(null);
        canReadSize = 0;
      } else if (recvType === EWebSocketOpcode["Text"]) {
        // 如果是文本数据，触发text事件
        this.emit("text", String(Buffer.concat(buffers)));
      }

      // console.log("recvLen", this.recvLen, "recvType", this.recvType);
    }
  }

  // 发送队列，存储待发送的数据
  private sendQueue: (Buffer | stream.Readable | string)[] = [];
  // 发送忙碌标志
  public sendBusy = false;

  /**
   * 发送数据
   * @param data 要发送的数据，可以是Buffer、Readable流或字符串
   * @returns this，用于链式调用
   */
  public send(data: Buffer | stream.Readable | string) {
    // 将数据添加到发送队列
    this.sendQueue.push(data);
    // 尝试清理队列
    this.tryToCleanQueue();
    return this;
  }

  /**
   * 尝试清理发送队列
   */
  private async tryToCleanQueue() {
    // 如果正在发送或队列为空，直接返回
    if (this.sendBusy || this.sendQueue.length === 0) {
      return;
    }
    // 设置发送忙碌标志
    this.sendBusy = true;
    // 从队列中取出一个任务
    const task = this.sendQueue.splice(0, 1)[0];
    // 是否是第一个分片的标志
    let isStart = true;

    /**
     * 创建WebSocket帧头部
     * @param type 操作码类型
     * @param len 数据长度
     * @returns 包含头部的Buf对象
     */
    const makeHeadBuf = (type: number, len: number) => {
      const buf = new Buf();
      if (isStart) {
        // 如果是第一个分片，设置操作码
        buf.writeUIntBE(type, 1);
        isStart = false;
      } else {
        // 如果不是第一个分片，操作码为0（延续帧）
        buf.writeUIntBE(0, 1);
      }

      // 根据数据长度设置长度字段
      if (len < 126) {
        // 如果长度小于126，直接使用1字节表示
        buf.writeUIntBE(len, 1);
      } else if (len < 65536) {
        // 如果长度小于65536，使用3字节表示（1字节为126，2字节为长度）
        buf.writeUIntBE(126, 1).writeUIntBE(len, 2);
      } else {
        // 如果长度大于等于65536，使用9字节表示（1字节为127，8字节为长度）
        buf.writeUIntBE(127, 1).writeUIntBE(len, 8);
      }
      return buf;
    };

    // 处理不同类型的数据
    if (task instanceof stream.Readable) {
      // 如果是可读流，监听data事件
      task.on("data", chunk => {
        // 发送数据
        if (!this.socket.write(Buffer.concat([makeHeadBuf(2, chunk.length).buffer, chunk]))) {
          // 如果套接字缓冲区已满，暂停流
          task.pause();
          // 当套接字缓冲区可用时，恢复流
          this.socket.once("drain", () => task.resume());
        }
      });

      // 监听end事件
      task.on("end", () => {
        // 发送结束帧
        this.socket.write(Buffer.from([128, 0]));
        // 重置发送忙碌标志
        this.sendBusy = false;
        // 尝试清理队列
        this.tryToCleanQueue();
      });
    } else {
      // 如果是文本或Buffer
      const isText = !(task instanceof Object);
      // 创建数据缓冲区
      const dataBuf = new Buf(Buffer.from(task));

      // 分片发送数据
      while (dataBuf.offset < dataBuf.buffer.length) {
        // 读取一个分片
        const chunk = dataBuf.read(Number(this.opts.sendHighWaterMark));
        // 创建帧头部
        const buf = makeHeadBuf(isText ? 1 : 2, chunk.length);

        // 如果是最后一个分片，设置FIN标志
        if (dataBuf.offset === dataBuf.buffer.length) {
          buf.buffer[0] += 128;
        }

        // 发送数据
        if (!this.socket.write(Buffer.concat([buf.buffer, chunk]))) {
          // 如果套接字缓冲区已满，等待drain事件
          await new Promise(resolve => this.socket.once("drain", resolve));
        }
      }

      // 重置发送忙碌标志
      this.sendBusy = false;
      // 尝试清理队列
      this.tryToCleanQueue();
    }
  }

  /**
   * 发送Ping帧并等待Pong响应
   * @param timeout 超时时间，默认为5000毫秒
   * @returns Promise，解析为延迟时间（毫秒）
   */
  public ping = (timeout: number = 5000) =>
    new Promise((resolve, reject) => {
      // 生成随机数作为Ping的标识
      let rand = 0;
      do {
        rand = ((Math.random() * 1e11) | 0) - (1 << 31);
      } while (this.pingCallBacks.has(rand));

      // 设置超时定时器
      const timer = setTimeout(() => {
        if (this.pingCallBacks.has(rand)) {
          // 如果超时仍未收到Pong响应，删除回调并拒绝Promise
          this.pingCallBacks.delete(rand);
          reject(new Error("timeout:" + timeout + "ms"));
          return;
        }
      }, timeout);

      // 设置Pong回调
      this.pingCallBacks.set(rand, () => {
        // 清除超时定时器
        clearTimeout(timer);
        // 删除回调
        this.pingCallBacks.delete(rand);
        // 解析Promise，返回延迟时间
        resolve(new Date().getTime() - time);
      });

      // 创建Ping帧
      const buf = new Buf();
      buf.writeUIntBE(0x89, 1); // 0x89 = 10001001，表示Ping帧且FIN为1
      buf.writeUIntBE(4, 1); // 数据长度为4字节
      buf.writeUIntBE(rand, 4); // 写入随机数
      // 发送Ping帧
      this.socket.write(buf.buffer);
      // 记录发送时间
      const time = new Date().getTime();
    });

  // 存储Ping回调的Map，键为随机数，值为回调函数
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
