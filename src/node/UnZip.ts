import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { Buf } from "./Buf";
import { IReadStream } from "./utils";
import { RecvStream } from "./RecvStream";

export type IUnZipHead = {
  version: number;
  flag: number;
  compressionMethod: number;
  lastModificationTime: number;
  lastModificationDate: number;
  CRC: Buffer;
  compressedSize: number;
  uncompressedSize: number;
  fileNameLength: number;
  extraFieldLength: number;
  fileName?: string;
  extraField?: Buffer;
  filePath: string;
  fileRecvStream?: IReadStream;
};
export class UnZip {
  private dirCache: Set<string> = new Set();
  private outputPath: string;
  private recvStream: RecvStream;
  private onFile?: (fileHead: IUnZipHead) => void;
  private zipFileHead = [0x50, 0x4b, 3, 4];
  private getHead(index = 0, err_time = 0) {
    if (index >= this.zipFileHead.length) {
      this.readFileInfo();
      return;
    }
    this.recvStream.readBuffer(1, ([sign]) => {
      if (sign === this.zipFileHead[index]) {
        this.getHead(index + 1);
        return;
      }
      if (err_time > 50) {
        process.nextTick(() => this.getHead(0, 0));
        return;
      }
      this.getHead(0, err_time + 1);
    });
  }
  private readFileInfo() {
    this.recvStream.readBuffer(26, headerBuf => {
      const buf = new Buf(headerBuf);
      const info: IUnZipHead = {
        version: buf.readUIntLE(2),
        flag: buf.readUIntLE(2),
        compressionMethod: buf.readUIntLE(2),
        lastModificationTime: buf.readUIntLE(2),
        lastModificationDate: buf.readUIntLE(2),
        CRC: buf.read(4),
        compressedSize: buf.readUIntLE(4),
        uncompressedSize: buf.readUIntLE(4),
        fileNameLength: buf.readUIntLE(2),
        extraFieldLength: buf.readUIntLE(2),
        filePath: "",
      };

      /** 读取File name */
      this.recvStream.readBuffer(info.fileNameLength, fileBuf => {
        info.fileName = String(fileBuf);

        /** 读取Extra field */
        this.recvStream.readBuffer(info.extraFieldLength, extraBuf => {
          info.extraField = extraBuf;

          /** 读取文件内容 */
          info.filePath = path.join(this.outputPath, info.fileName || "");
          this.mkdir(path.dirname(info.filePath), () => {
            if (info.compressedSize) {
              this.recvStream.readStream(info.compressedSize, fileStream => {
                if (info.compressionMethod === 8 || info.compressionMethod === 9) {
                  info.fileRecvStream = fileStream.pipe(zlib.createInflateRaw());
                } else {
                  info.fileRecvStream = fileStream;
                }
                if (this.onFile) {
                  this.onFile(info);
                } else {
                  info.fileRecvStream?.pipe(fs.createWriteStream(info.filePath));
                }
                this.getHead();
              });
              return;
            }
            this.onFile && this.onFile(info);
            this.getHead();
          });
        });
      });
    });
  }
  private mkdir(path: string, callback: () => void) {
    if (this.dirCache.has(path)) {
      callback();
      return;
    }
    fs.mkdir(path, { recursive: true }, err => {
      this.dirCache.add(path);
      callback();
    });
  }
  constructor(
    readStream: IReadStream,
    onFile?: (fileHead: IUnZipHead) => void,
    outputPath: string = __dirname + "/unzip/"
  ) {
    this.outputPath = outputPath;
    this.onFile = onFile;
    this.recvStream = new RecvStream(readStream);
    this.getHead();
  }
}

// require("https").get(
//   "https://updatecdn.meeting.qq.com/cos/302a95c9dfa9d25256c464e0af7655a7/TencentMeeting_0300000000_3.12.6.436.publish.apk",
//   res => {
//     new UnZip(res, info => {
//       info.fileRecvStream?.pipe(fs.createWriteStream(info.filePath));
//       delete info.fileRecvStream;
//       console.log(info);
//     });
//   }
// );
// console.time("time");
// new UnZip(fs.createReadStream("1.zip"), info => {
//   info.fileRecvStream?.pipe(fs.createWriteStream(info.filePath));
//   // delete info.fileRecvStream;
//   //console.log(info);
// });
// process.on("exit", () => {
//   console.timeEnd("time");
//   console.log("exit");
// });
