import * as net from "net";
import * as http from "http";
import * as stream from "stream";
import * as crypto from "crypto";
import { RecvStreamPro } from "./RecvStreamPro";
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
  subStream: (subStream: stream.Readable, isText: boolean) => void; // 接收到大于maxTextSize|maxBufferSize的文本|二进制流时触发的事件
  text: (text: string) => void; // 接收到小于maxTextSize的文本数据时触发的事件
  binary: (buffer: Buffer) => void; // 接收到小于maxBufferSize的二进制数据时触发的事件
  ping: (buffer: Buffer) => void; // 接收到Ping帧时触发的事件
  pong: (buffer: Buffer) => void; // 接收到Pong帧时触发的事件
  error: (err: Error) => void; // 发生错误时触发的事件
  close: () => void; // 连接关闭时触发的事件
};

/**
 * WebSocket 数据接收和解析器。
 * 负责从 TCP 流中解析 WebSocket 帧，并根据帧的类型和内容触发相应的事件。
 */
export class WebSocketRecv extends TypedEventEmitter<IWebSocketEvents> {
  // 锁，用于防止 recvData 方法被并发或重复调用。
  private isLocked = false;

  constructor() {
    super();
  }

  /**
   * 启动接收和解析来自客户端的 WebSocket 数据帧的循环。
   * @param socket 底层的 net.Socket 连接实例。
   * @param maxTextSize 在内存中缓冲的最大文本消息字节数，超过后会尝试转为流模式。
   * @param maxBufferSize 在内存中缓冲的最大二进制消息字节数，超过后会尝试转为流模式。
   */
  public async recvData(socket: net.Socket, maxTextSize: number = 64 * 1024 * 1024, maxBufferSize: number = 64 * 1024) {
    // 确保此核心接收逻辑只被执行一次。
    if (this.isLocked) throw new Error("recvData 只能调用一次");
    this.isLocked = true;

    // RecvStreamPro 是一个自定义的流处理器，能方便地按需读取指定长度的数据。
    const inputStream = new RecvStreamPro();
    inputStream.once("pipe", () => this.emit("connected"));

    // 将原始 socket 的数据流导入到我们的处理器中。
    socket.pipe(inputStream);

    // --- 消息缓冲相关变量 ---
    // 用于存储同一个消息的多个数据帧（分片）。
    const messageFragments: Buffer[] = [];
    // 当前已缓冲的数据帧的总长度。
    let fragmentsTotalLength: number = 0;

    // --- 流式处理相关变量 (用于超大载荷) ---
    // 当消息大小超过阈值时，创建此可读流来处理后续数据。
    let payloadStream: stream.Duplex | undefined;
    // 为流式处理的载荷提供掩码服务的队列。
    const payloadStreamMaskQueue: WebSocketMaskApplier[] = [];

    // Transform 函数：当数据通过 payloadStream 时，此函数被调用以应用掩码。
    const transform = (chunk: Buffer, encoding: string, callback: (err: Error | null, buffer: Buffer) => void) => {
      let offset = 0;
      // 只要当前数据块还有未处理的部分...
      while (offset < chunk.length) {
        // 从队列头部取出一个掩码应用器。
        const currentMaskApplier = payloadStreamMaskQueue[0];
        // 如果队列为空，则停止处理。
        if (!currentMaskApplier) break;

        // 应用掩码，并更新偏移量。
        offset = currentMaskApplier.apply(chunk, offset);

        // 如果这个掩码应用器的任务已完成（即其对应的帧数据已全部处理），则将其从队列中移除。
        if (currentMaskApplier.isDone()) {
          payloadStreamMaskQueue.shift();
        }
      }
      // 将处理（解掩码）后的数据块传递给流的下一环节。
      callback(null, chunk);
    };

    /**
     * =================================================================
     * 主循环：开始持续接收和处理一个完整的 WebSocket 消息。
     * 一个消息可能由一个或多个数据帧(Frame)构成。
     * =================================================================
     */
    while (true) {
      // 每次外循环开始时，重置消息的操作码类型。
      let opcode: EWebSocketOpcode = EWebSocketOpcode.Continuation;
      let recvBufferPromise: Promise<Buffer> | Buffer | undefined;
      let recvBuffer: Buffer | undefined;

      /**
       * -----------------------------------------------------------------
       * 内部循环：处理构成单个消息的每一个数据帧。
       * -----------------------------------------------------------------
       */
      while (true) {
        recvBufferPromise = undefined;
        recvBuffer = undefined;

        // 1. 读取并解析帧头 (前 2 个字节)
        recvBufferPromise = inputStream.readBuffer(2);
        recvBuffer = recvBufferPromise instanceof Promise ? await recvBufferPromise : recvBufferPromise;

        const firstByte = recvBuffer[0];
        // FIN 位 (最高位): `true` 表示这是消息的最后一个分片。
        const isFinalFrame = (firstByte & 0b10000000) !== 0; // 检查是否 >= 128

        // 获取操作码(Opcode)。如果为 0 (Continuation Frame)，则沿用上一个数据帧的 opcode。
        opcode = firstByte & 0b00001111 || opcode;

        // 根据 WebSocket 规范，如果收到未知的 opcode，服务端必须关闭连接。
        if (EWebSocketOpcode[opcode] === undefined) {
          socket.end();
          const err = new Error("Received unknown opcode");
          if (!this.emit("error", err)) throw err;
          return;
        }

        // 2. 解析载荷长度 (Payload Length) 和 MASK 位
        const secondByte = recvBuffer[1];
        let payloadLength = secondByte;
        // MASK 位 (最高位): `true` 表示该帧使用了掩码。客户端发来的帧必须使用掩码。
        const isMasked = (payloadLength & 0b10000000) !== 0; // 检查是否 >= 128
        // 移除 MASK 位，获取基础长度。
        payloadLength &= 0b01111111; // 等同于 %= 128

        // 根据基础长度的值，判断是否需要读取扩展长度。
        if (payloadLength > 125) {
          // 长度为 126: 接下来 2 个字节是真实长度。
          // 长度为 127: 接下来 8 个字节是真实长度。
          recvBufferPromise = inputStream.readBuffer(payloadLength === 127 ? 8 : 2);
          recvBuffer = recvBufferPromise instanceof Promise ? await recvBufferPromise : recvBufferPromise;
          // 使用位运算从多字节 buffer 中高效地计算出实际长度。
          payloadLength = 0;
          for (let i = 0; i < recvBuffer.length; i++) {
            payloadLength <<= 8; // 左移8位，为下一个字节腾出空间。
            payloadLength |= recvBuffer[i]; // 合并当前字节。
          }
        }

        // 3. 读取掩码 (如果存在)
        let maskApplier: WebSocketMaskApplier | undefined;
        if (isMasked) {
          recvBufferPromise = inputStream.readBuffer(4);
          recvBuffer = recvBufferPromise instanceof Promise ? await recvBufferPromise : recvBufferPromise;
          // 创建掩码应用器实例。
          maskApplier = new WebSocketMaskApplier([...recvBuffer], payloadLength);
        }

        // 4. 读取载荷数据 (Payload Data) 并处理
        const isTextFrame = opcode === EWebSocketOpcode.Text;
        const isControlFrame = opcode >= EWebSocketOpcode.Close; // 控制帧 (Close, Ping, Pong)
        const maxAllowedBufferSize = Number(isTextFrame ? maxTextSize : maxBufferSize) - fragmentsTotalLength;

        // 计算本次应从流中读取的字节数。
        const bytesToReadNow = Math.min(payloadLength, isControlFrame ? 64 * 1024 : maxAllowedBufferSize);

        recvBufferPromise = undefined;
        recvBuffer = undefined;

        if (bytesToReadNow > 0) {
          recvBufferPromise = inputStream.readBuffer(bytesToReadNow);
          recvBuffer = recvBufferPromise instanceof Promise ? await recvBufferPromise : recvBufferPromise;
          // 剩余未读取的载荷长度。
          payloadLength -= bytesToReadNow;

          // 如果有掩码，立即应用。
          if (isMasked) maskApplier?.apply(recvBuffer);

          // 非控制帧的数据需要被缓冲起来，等待合并。
          if (!isControlFrame) {
            messageFragments.push(recvBuffer);
            fragmentsTotalLength += recvBuffer.length;
          }
        }

        // 5. 根据帧类型执行相应操作
        // 5.1. 处理控制帧
        if (isControlFrame) {
          recvBuffer = recvBuffer ?? Buffer.allocUnsafe(0);
          if (opcode === EWebSocketOpcode.Close) {
            socket.end(); // 收到关闭帧，关闭连接。
            return;
          } else if (opcode === EWebSocketOpcode.Ping) {
            // 收到 Ping，回复一个 Pong 帧。
            // socket.write(Buffer.concat([Buffer.from([0x8a, recvBuffer.length]), recvBuffer]));
            this.emit("ping", recvBuffer);
            break; // 控制帧是独立的，处理完后跳出内循环，等待新消息。
          } else if (opcode === EWebSocketOpcode.Pong) {
            this.emit("pong", recvBuffer);
            break; // 处理完后跳出内循环。
          }
          console.warn("暂不支持的控制帧", opcode);
          break;
        }

        // 5.2. 如果载荷超大，切换到流式处理
        if (payloadLength > 0) {
          // 如果 payloadStream 还未创建，则初始化它。
          if (!payloadStream) {
            payloadStreamMaskQueue.length = 0;
            payloadStream = new stream.Transform({ transform });
            // 触发 subStream 事件，让外部逻辑可以消费这个流。
            if (!this.emit("subStream", payloadStream, isTextFrame)) {
              console.warn("未添加 subStream 事件监听器，websocket 的所有 stream 都将被丢弃!");
              // payloadStream = undefined; // 如果没有监听者，则放弃流式处理。
            }
          }

          // 将已缓冲的数据推入流中。
          recvBufferPromise = undefined;
          recvBuffer = messageFragments.length > 1 ? Buffer.concat(messageFragments) : messageFragments[0];
          messageFragments.length = 0;

          if (payloadStream) {
            // 已存在的解掩码缓存，直接推送子流
            if (recvBuffer?.length) payloadStream.push(recvBuffer);

            // 将当前帧的掩码应用器加入队列，供后续数据使用。
            payloadStreamMaskQueue.push(maskApplier ?? new WebSocketMaskApplier([], payloadLength));

            // 创建一个只读取剩余载荷长度的子流，并将其导入 payloadStream。
            const remainingStream = inputStream.readStream(payloadLength);
            remainingStream.pipe(payloadStream, { end: false }); // end: false 防止 pipe 自动关闭目标流。

            // 等待子流读取完毕。
            await new Promise(resolve => remainingStream.on("close", resolve));
            // 如果下游流缓冲区已满，等待 'drain' 事件。
            if (payloadStream.writableNeedDrain) await new Promise(resolve => payloadStream!.on("drain", resolve));
          }

          // 如果这是消息的最后一帧，则结束流。
          if (isFinalFrame) {
            payloadStream?.push(null);
            payloadStreamMaskQueue.length = 0;
            payloadStream = undefined;
            fragmentsTotalLength = 0;
          }
          break; // 当前帧（可能是个超长帧的开始部分）处理完毕，跳出内循环。
        }

        // 5.3. 如果是最后一帧 (且未进入流模式)，提交已缓冲的数据。
        if (isFinalFrame) {
          recvBuffer = messageFragments.length > 1 ? Buffer.concat(messageFragments) : messageFragments[0];
          if (isTextFrame) {
            this.emit("text", String(recvBuffer));
          } else {
            this.emit("binary", recvBuffer);
          }
          // 重置缓冲区，准备接收下一个新消息。
          recvBufferPromise = undefined;
          recvBuffer = undefined;
          messageFragments.length = 0;
          fragmentsTotalLength = 0;
          break; // 当前消息处理完毕，跳出内循环。
        }
        // 如果还不是最后一帧，则留在内循环中，继续接收下一个分片。
      }
    }
  }
}

// WebSocket类，继承自TypedEventEmitter，实现WebSocket协议
export class WebSocket extends WebSocketRecv {
  // 标识当前连接是否是WebSocket连接
  public isWebSocket = false;
  // 底层TCP套接字
  private socket: net.Socket;
  // 接收数据的流
  // WebSocket选项配置
  public opts: { maxTextSize?: number; maxBufferSize?: number; sendHighWaterMark?: number };

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

    // 设置发送缓冲区大小，默认为64KB
    this.opts.sendHighWaterMark = this.opts.sendHighWaterMark ?? 64 * 1024;
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

      // 恢复套接字数据流
      // this.socket.resume();
      // 标记为WebSocket连接
      this.isWebSocket = true;
      // 在下一个事件循环中触发connected事件并开始接收数据
      process.nextTick(() => {
        this.recvData(req.socket, opts?.maxTextSize, opts?.maxBufferSize);
      });
      this.on("ping", buffer => {
        // 收到对面的Ping，要回一个Pong
        this.socket.write(Buffer.concat([Buffer.from([EWebSocketOpcode.Pong | 0x80, buffer.length]), buffer]));
      });
      this.on("pong", buffer => {
        // 对面回了Pong帧，调用对应的回调函数（私有协议）
        if (buffer.length === 4) this.pingCallBacks.get(buffer.readUInt32BE()!)?.();
      });
      // 监听套接字关闭事件
      this.socket.once("close", () => this.emit("close"));
    } else {
      // 如果不是WebSocket升级请求，触发关闭事件
      this.emit("close");
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
    const task = this.sendQueue.shift()!;
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
      // console.log("ping", rand);
      // 设置Pong回调
      this.pingCallBacks.set(rand, () => {
        // 清除超时定时器
        clearTimeout(timer);
        // 删除回调
        this.pingCallBacks.delete(rand);
        // 解析Promise，返回延迟时间
        resolve(performance.now() - time);
      });

      // 创建Ping帧
      const buf = new Buf();
      buf.writeUIntBE(0x89, 1); // 0x89 = 10001001，表示Ping帧且FIN为1
      buf.writeUIntBE(4, 1); // 数据长度为4字节
      buf.writeUIntBE(rand, 4); // 写入随机数
      console.log(buf.buffer);
      // 发送Ping帧
      this.socket.write(buf.buffer);
      // 记录发送时间
      const time = performance.now();
    });

  // 存储Ping回调的Map，键为随机数，值为回调函数
  private pingCallBacks: Map<number, () => void> = new Map();
}

/**
 * WebSocket 掩码应用工具类
 *
 * 该类用于将一个 4 字节的掩码密钥持续应用到一个数据流上。
 * 它会记住当前掩码的位置，以便在处理分块数据时能够正确地继续应用掩码。
 */
export class WebSocketMaskApplier {
  // 存储 4 字节的掩码密钥
  private readonly maskingKey: number[];

  // 当前在掩码密钥中的位置 (0-3)
  private maskIndex: number = 0;

  // 剩余需要应用掩码的总字节数
  private remainingBytes: number;

  /**
   * 创建一个掩码应用器实例
   * @param mask - 4 字节的掩码密钥，可以是 Uint8Array 或数字数组。
   * @param payloadLength - 需要应用掩码的数据总长度（字节数）。
   */
  constructor(mask: number[], payloadLength: number) {
    // 协议要求掩码必须是 4 字节，这是一个关键的先决条件。
    // if (mask.length !== 4) {
    //   throw new Error("Masking key must be 4 bytes long.");
    // }
    this.maskingKey = mask;
    this.remainingBytes = payloadLength;
  }

  /**
   * 对传入的 Buffer 应用掩码（原地修改），此版本为性能优化版。
   *
   * 此方法通过优先处理 4 字节对齐的数据块来提升处理速度，
   * 剩余不足 4 字节的数据则逐字节处理。
   * 方法可以被多次调用，直到所有数据都被处理完毕。
   *
   * @param buffer - 需要应用掩码的数据块 (Buffer)。
   * @param offset - 开始应用掩码的缓冲区起始位置，默认为 0。
   * @returns 返回处理结束时在缓冲区中的位置（即 offset + 已处理的字节数）。
   */
  public apply(buffer: Buffer, offset: number = 0): number {
    // 如果没有剩余字节需要处理，则直接返回当前偏移量，不执行任何操作。
    if (this.isDone()) return offset;

    // 1. 计算本次调用实际需要处理的字节数。
    //    取 "总剩余字节数" 和 "当前缓冲区可用长度" 中的较小值。
    const bytesToProcess = Math.min(this.remainingBytes, buffer.length - offset);

    // 预先计算处理结束后的偏移量。
    const endOffset = offset + bytesToProcess;

    // 检查掩码密钥是否有效（此检查理论上在构造函数已完成，此处为双重保险）。
    if (this.maskingKey.length === 4) {
      // 2. 优化：优先处理 4 字节对齐的数据块。
      //    计算出可以被 4 整除的最大偏移量终点。
      //    `>> 2` 相当于除以 4 并取整，`<< 2` 相当于再乘以 4，以此找到最后一个完整的 4 字节块的边界。
      const endOffsetAligned = offset + ((bytesToProcess >> 2) << 2);

      // 一次性处理 4 个字节，减少循环次数。
      while (offset < endOffsetAligned) {
        // 直接对 4 个连续字节应用掩码。
        // this.maskIndex 保持不变，因为我们总是从掩码的当前位置开始，应用一个完整的周期。
        buffer[offset] ^= this.maskingKey[this.maskIndex & 3];
        buffer[offset + 1] ^= this.maskingKey[(this.maskIndex + 1) & 3];
        buffer[offset + 2] ^= this.maskingKey[(this.maskIndex + 2) & 3];
        buffer[offset + 3] ^= this.maskingKey[(this.maskIndex + 3) & 3];
        offset += 4; // 每次前进 4 个字节。
      }

      // 3. 处理剩余的字节 (0 到 3 个字节)。
      while (offset < endOffset) {
        // 对剩余的每个字节应用掩码。
        buffer[offset++] ^= this.maskingKey[this.maskIndex];
        // 在这里，掩码索引需要递增并循环，为下一次操作做准备。
        this.maskIndex = (this.maskIndex + 1) & 3;
      }
    }

    // 4. 更新剩余需要处理的总字节数。
    this.remainingBytes -= bytesToProcess;

    // 5. 返回处理结束后的新偏移量。
    return endOffset;
  }

  /**
   * 检查是否所有指定长度的数据都已应用了掩码。
   * @returns 如果所有数据都已处理，则返回 true；否则返回 false。
   */
  public isDone(): boolean {
    return this.remainingBytes <= 0;
  }
}

// new WebSocketRecv().on("subStream", () => {});

// 测试用例
http
  .createServer((req, res) => {
    const t = new WebSocket(req, res, {})
      .on("subStream", (subStream, isText) => {
        console.log("subStream----------------------------------", isText);

        // let t = 0;
        // subStream.on("data", c => console.log("收到", (t += c.length)));

        // subStream.on("end", () => console.log("结束", t));
        subStream.pipe(require("fs").createWriteStream("ttt.bin"));
      })
      .on("text", txt => {
        console.log("文字", txt.length, txt);
      })
      .on("binary", txt => {
        console.log("binary", txt);
      })
      .on("connected", () => {
        //t.send(require("fs").createReadStream("ttt.bin"));
        // t.send("1234567890".repeat(1024 * 10));
        setTimeout(() => {
          t.ping().then(delay => console.log("与客户端延迟：", delay, "ms"));
        }, 500);
      })
      .on("ping", buf => console.log("ping", buf))
      .on("error", e => {
        console.log(e);
      });
    t.isWebSocket || res.end("404");
  })
  .listen(80);
