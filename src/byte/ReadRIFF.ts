/** 参考资料：https://johnloomis.org/cpe102/asgn/asgn1/riff.html */
import { RecvStreamPro } from "./RecvStreamPro";
export type IRiffChunk = {
  ckID: string;
  ckSize: number;
  ckType?: string;
  parent: IRiffChunk | null;
};
const PARENT_ID = new Set(["RIFF", "LIST"]);
export class ReadRIFF extends RecvStreamPro {
  private readonly onChunk: (this: ReadRIFF, chunk: IRiffChunk) => Promise<void>;
  constructor(onChunk: ReadRIFF["onChunk"]) {
    super();
    this.onChunk = onChunk.bind(this);
    this.readChunk(null, Infinity);
  }

  public readableBytes = 0;
  private async readChunk(parent: IRiffChunk | null, maxCanReadSize: number) {
    if (this.writableFinished) return Infinity;
    const head = this.readBuffer(8);
    const headBuf = head instanceof Promise ? await head : head;
    if (headBuf.length < 8) return Infinity;
    const chunk: IRiffChunk = {
      ckID: String(headBuf.subarray(0, 4)),
      ckSize: Math.min(maxCanReadSize, headBuf.readUInt32LE(4)),
      parent,
    };
    /** 实际占用的大小 */
    let realSize = chunk.ckSize;
    /** 是否可以有子标签 */
    if (PARENT_ID.has(chunk.ckID)) {
      const ckType = this.readBuffer(4);
      chunk.ckType = String(ckType instanceof Promise ? await ckType : ckType);
      realSize = 12;
      await this.onChunk(chunk);
      let unReadSize = chunk.ckSize - 4;
      this.readableBytes += realSize;
      while (this.isClose === false && unReadSize >= 8) {
        unReadSize -= await this.readChunk(chunk, unReadSize);
      }
      if (unReadSize > 0) {
        //   console.log("多余字节", unReadSize);
        await this.readBuffer(unReadSize);
      }
      return realSize;
    }
    await this.onChunk(chunk);

    /** 块的末尾会填充到 WORD（16 位）边界 */
    if (realSize % 2) {
      await this.readBuffer(1);
      realSize++;
    }
    realSize += 8;
    this.readableBytes += realSize;
    return realSize;
  }
  private isClose = false;
  public close() {
    this.isClose = true;
    this.isFinal || this.end();
  }
}

// import * as fs from "fs";
/** 测试用例1 读取wav */
// fs.createReadStream("t.wav").pipe(
//   new ReadRIFF(async function (chunk) {
//     console.log(chunk, this.readableBytes);
//     if (!chunk.ckType) {
//       if (chunk.ckSize > 10000000) {
//         let size = 0;
//         for await (const chuck of this.readStream(chunk.ckSize)) {
//           //   console.log(chuck);
//           size += chuck.length;
//         }
//         console.log("-".repeat(process.stdout.columns));
//         console.log("已读取", size);
//         console.log("-".repeat(process.stdout.columns));

//         return;
//       }
//       const data = await this.readBuffer(chunk.ckSize);
//       chunk.ckSize < 1000000 && console.log([String(data)]);
//     }
//   }),
// );

/** 测试用例2 读取webp */
// fs.createReadStream("t.webp").pipe(
//   new ReadRIFF(async function (chunk) {
//     console.log(chunk);
//     if (!chunk.ckType) {
//       const data = await this.readBuffer(chunk.ckSize);
//     }
//   }),
// );

/** 测试用例3 解析wav */
// fs.createReadStream("t.wav").pipe(
//   new ReadRIFF(async function (chunk) {
//     console.log(chunk);
//     if (chunk.parent?.ckType === "WAVE") {
//       if (chunk.ckID === "fmt ") {
//         const headBuf = await this.readBuffer(chunk.ckSize);
//         console.log({
//           numChannels: headBuf.readUInt16LE(2),
//           sampleRate: headBuf.readUInt32LE(4),
//           byteRate: headBuf.readUInt32LE(8),
//           blockAlign: headBuf.readUInt16LE(12),
//           bitsPerSample: headBuf.readUInt16LE(14),
//         });
//         return;
//       }
//       if (chunk.ckID === "data") {
//         this.close();
//         return;
//       }
//     }
//     if (!chunk.ckType) await this.readBuffer(chunk.ckSize);
//   }),
// );
