import * as stream from "stream";

export class AggregationStream extends stream.Readable {
  private chuckCount: number;
  private threadCount: number;
  private callback: (index: number, threadId: number) => Promise<Buffer>;
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
  constructor(chuckCount: number, threadCount: number, callback: AggregationStream["callback"]) {
    super();
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
