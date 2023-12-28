import * as stream from "stream";

export class AggregationStream extends stream.Readable {
  private chuckCount: number = 0;
  private threadCount: number = 0;
  private callback: (index: number, threadId: number) => Promise<Buffer> = async () => Buffer.alloc(0);
  private queue: { buf: Buffer; index: number; threadId: number }[] = [];
  private nowIndex = 0;
  private loadIndex = 0;
  private canPush = true;
  private tryToPush() {
    if (!this.canPush) {
      return;
    }
    // console.log("消费", this.queue, this.nowIndex);
    if (this.queue[0]) {
      const { buf, index, threadId } = this.queue.shift() || {};
      if (this.nowIndex !== index) {
        console.log(this.queue);
        throw new Error(this.nowIndex + "," + Number(index) + "对不上");
      }
      this.nowIndex++;
      //   console.log("index", index);
      this.push(buf);
      this.canPush = false;
      this.tryToNewThread(threadId || 0);
    }
  }
  private async tryToNewThread(threadId: number) {
    if (this.chuckCount <= 0) {
      this.threadCount--;
      if (this.threadCount <= 0) {
        // console.log("exit");
        this.push(null);
      }
      return;
    }
    this.chuckCount--;
    const index = this.loadIndex++;
    const buf = await this.callback(index, threadId);
    // console.log(index, this.nowIndex, this.queue);
    this.queue[index - this.nowIndex] = { index, buf, threadId };
    this.tryToPush();
  }
  constructor(chuckCount?: number, threadCount?: number, callback?: AggregationStream["callback"]) {
    super();
    if (chuckCount && threadCount && callback) this.start(chuckCount, threadCount, callback);
  }
  public start(chuckCount: number, threadCount: number, callback: AggregationStream["callback"]) {
    if (this.chuckCount) throw new Error("已经开始了");
    this.chuckCount = chuckCount;
    this.threadCount = Math.min(chuckCount, threadCount);
    this.callback = callback;
    for (let i = 0; i < this.threadCount; i++) {
      this.tryToNewThread(i);
    }
  }
  _read() {
    this.canPush = true;
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
// import * as https from "https";
// import * as fs from "fs";
// /** 显示网速，非必须 */
// import { ShowTransferProgress } from "./ShowTransferProgress";

// const downloadUrl =
//   "https://f.c2r.ts.cdn.office.net/pr/55336b82-a18d-4dd6-b5f6-9e5095c314a6/Office/Data/16.0.16130.20394/stream.x64.x-none.dat";

// const maxSockets = 10;
// /** 每次下载的大小 */
// const bufferSizePerRes = 1024 * 1024;
// const agent = new https.Agent({ maxSockets });
// https.get(downloadUrl, { agent }, res => {
//   const size = Number(res.headers["content-length"] || 0);
//   if (!res.headers["accept-ranges"] || !size) {
//     console.log(res.headers);
//     throw new Error("服务端不允许分片下载或文件大小为0");
//   }
//   const fileName = (String(res.headers["content-disposition"] || "").match(/filename=([^;]+)/) || [])[1] || "data.bin";
//   /** 显示网速，非必须 */
//   const showTransferProgress = new ShowTransferProgress(fileName, size);
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
//           }
//         )
//       )
//   ).pipe(fs.createWriteStream(fileName));
// });
