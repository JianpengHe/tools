/**
 * 聚合流模块
 * 实现了一个可以并行处理多个数据块并按顺序输出的可读流
 * 主要用于并行下载、并行读取文件等场景，可以提高数据处理效率
 */
import * as stream from "stream";

/**
 * 聚合流类
 * 继承自Node.js的Readable流，实现了并行获取数据并按顺序输出的功能
 * 可用于多线程下载、分片读取大文件等场景
 */
export class AggregationStream extends stream.Readable {
  /** 总数据块数量 */
  private chuckCount: number = 0;
  /** 并行线程数 */
  private threadCount: number = 0;
  /** 获取数据块的回调函数，参数为块索引和线程ID，返回包含数据的Promise */
  private callback: (index: number, threadId: number) => Promise<Buffer> = async () => Buffer.alloc(0);
  /** 数据块队列，用于存储已获取但尚未按顺序输出的数据块 */
  private queue: { buf: Buffer; index: number; threadId: number }[] = [];
  /** 当前需要输出的数据块索引 */
  private nowIndex = 0;
  /** 当前正在加载的数据块索引 */
  private loadIndex = 0;
  /** 是否可以推送数据到输出流 */
  private canPush = true;

  /**
   * 尝试推送数据到输出流
   * 按照索引顺序从队列中取出数据块并推送到流中
   */
  private tryToPush() {
    if (!this.canPush) {
      return;
    }
    // 如果队列中有数据且是当前需要的索引，则推送到输出流
    if (this.queue[0]) {
      const { buf, index, threadId } = this.queue.shift() || {};
      // 确保数据块顺序正确
      if (this.nowIndex !== index) {
        console.log(this.queue);
        throw new Error(this.nowIndex + "," + Number(index) + "对不上");
      }
      this.nowIndex++;
      // 推送数据到输出流
      this.push(buf);
      this.canPush = false;
      // 重用当前线程加载新的数据块
      this.tryToNewThread(threadId || 0);
    }
  }

  /**
   * 尝试启动新线程加载数据块
   * @param threadId 线程ID，用于标识不同的并行任务
   */
  private async tryToNewThread(threadId: number) {
    // 如果所有数据块都已加载，减少线程计数
    if (this.chuckCount <= 0) {
      this.threadCount--;
      // 如果所有线程都已完成，结束流
      if (this.threadCount <= 0) {
        this.push(null);
      }
      return;
    }
    // 减少剩余数据块计数并获取当前要加载的块索引
    this.chuckCount--;
    const index = this.loadIndex++;
    // 调用回调函数获取数据块
    const buf = await this.callback(index, threadId);
    // 将获取的数据块放入队列中的正确位置
    this.queue[index - this.nowIndex] = { index, buf, threadId };
    // 尝试推送数据
    this.tryToPush();
  }

  /**
   * 构造函数
   * @param chuckCount 总数据块数量
   * @param threadCount 并行线程数
   * @param callback 获取数据块的回调函数
   */
  constructor(chuckCount?: number, threadCount?: number, callback?: AggregationStream["callback"]) {
    super();
    // 如果提供了所有参数，立即启动流
    if (chuckCount && threadCount && callback) this.start(chuckCount, threadCount, callback);
  }

  /**
   * 启动聚合流
   * @param chuckCount 总数据块数量
   * @param threadCount 并行线程数
   * @param callback 获取数据块的回调函数
   */
  public start(chuckCount: number, threadCount: number, callback: AggregationStream["callback"]) {
    // 防止重复启动
    if (this.chuckCount) throw new Error("已经开始了");
    this.chuckCount = chuckCount;
    // 线程数不能超过数据块数
    this.threadCount = Math.min(chuckCount, threadCount);
    this.callback = callback;
    // 启动所有线程
    for (let i = 0; i < this.threadCount; i++) {
      this.tryToNewThread(i);
    }
  }

  /**
   * Readable流的_read方法实现
   * 当流需要更多数据时会调用此方法
   */
  _read() {
    // 设置可以推送数据的标志
    this.canPush = true;
    // 尝试推送数据
    this.tryToPush();
  }
}

// 测试用例
// fs.open("D:/test.bin", "r", (err, fd) => {
//     new AggregationStream(
//       10 * 1024,
//       10,
//       index =>
//         new Promise(r => {
//           const buf = Buffer.allocUnsafe(2 * 1024 * 1024);
//           fs.read(fd, buf, 0, buf.length, index * buf.length, err => {
//             // setTimeout(() => {
//             r(buf);
//             // }, Math.random() * 2000);
//           });
//         })
//     ).pipe(fs.createWriteStream("D:/test2.bin"));
//   });

// 测试用例（分片下载）
// import * as os from "os";
// import * as tls from "tls";
// import * as https from "https";
// import * as fs from "fs";
// /** 显示网速，非必须 */
// import { ShowTransferProgress } from "./ShowTransferProgress";

// const downloadUrl =
//   "https://f.c2r.ts.cdn.office.net/pr/55336b82-a18d-4dd6-b5f6-9e5095c314a6/Office/Data/16.0.16130.20394/stream.x64.x-none.dat";

// const maxSockets = 50;
// /** 每次下载的大小 */
// const bufferSizePerRes = 1024 * 1024;
// const agent = new https.Agent({ maxSockets, keepAlive: true });
// /** 多个网卡，非必须 */
// (() => {
//   // let sock = 0;
//   const ips: string[] = [];
//   for (const arr of Object.values(os.networkInterfaces())) {
//     const { address, internal } = arr?.find(({ family }) => family === "IPv4") || {};
//     if (internal) break;
//     address && ips.push(address);
//   }
//   console.log(ips);
//   // @ts-ignore
//   agent.createConnection = ({ host, port }, oncreate) => {
//     const localAddress = ips[Math.floor(ips.length * Math.random())];
//     console.log(host, port, localAddress);
//     // @ts-ignore
//     return tls.connect({ port, host, rejectUnauthorized: false, localAddress });
//   };
// })();

// https.get(downloadUrl, { agent }, res => {
//   const size = Number(res.headers["content-length"] || 0);
//   if (!res.headers["accept-ranges"] || !size) {
//     console.log(res.headers);
//     throw new Error("服务端不允许分片下载或文件大小为0");
//   }
//   const fileName = (String(res.headers["content-disposition"] || "").match(/filename=([^;]+)/) || [])[1] || "data.bin";
//   /** 显示网速，非必须 */
//   const showTransferProgress = new ShowTransferProgress({ title: fileName, totalSize: size, interval: 1000 });
//   console.log("启动服务，共", Math.ceil(size / bufferSizePerRes), "分片");
//   new AggregationStream(
//     Math.ceil(size / bufferSizePerRes),
//     maxSockets,
//     index =>
//       new Promise(r =>
//         https.get(
//           downloadUrl,
//           {
//             agent,

//             headers: {
//               range: `bytes=${bufferSizePerRes * index}-${Math.min(size, bufferSizePerRes * (index + 1) - 1)}`,
//             },
//           },
//           async splitRes => {
//             const body: Buffer[] = [];
//             for await (const chuck of splitRes) {
//               body.push(chuck);
//               showTransferProgress.add(chuck.length);
//             }
//             r(Buffer.concat(body));
//           },
//         ),
//       ),
//   ).pipe(fs.createWriteStream(fileName));
// });
