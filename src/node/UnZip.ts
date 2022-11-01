import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { Buf } from "./Buf";
import { IReadStream } from "./IReadStream";
import { recvAll } from "./RecvBuf";
import { IGetLengthFn, RecvStream } from "./RecvStream";
export class UnZip {
  private dirCache: Set<string> = new Set();
  private outputPath: string;
  private getLengthFn: IGetLengthFn = (headerBuf, readBufferFn) => {
    const buf = new Buf(headerBuf);
    const info = {
      head: buf.readUIntLE(4),
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
      fileName: "",
    };
    if (info.head !== 0x04034b50) {
      return;
    }
    const ReadStream = readBufferFn(info.compressedSize + info.fileNameLength + info.extraFieldLength);
    let needReadFileNameSize = info.fileNameLength + info.extraFieldLength;
    const fileNameBufs: Buffer[] = [];
    const needReadFileName = () => {
      ReadStream.once("readable", () => {
        let data: Buffer;
        while (needReadFileNameSize && (data = ReadStream.read(needReadFileNameSize))) {
          if (data && data.length) {
            needReadFileNameSize -= data.length;
            fileNameBufs.push(data);
          }
        }
        if (needReadFileNameSize) {
          needReadFileName();
        } else {
          info.fileName = path.join(this.outputPath, String(Buffer.concat(fileNameBufs).slice(0, info.fileNameLength)));
          const { dir } = path.parse(info.fileName);
          if (!this.dirCache.has(dir)) {
            fs.mkdir(dir, { recursive: true }, () => {
              this.dirCache.add(dir);
              writeFile();
            });
          } else {
            writeFile();
            //process.nextTick(writeFile);
          }
        }
      });
    };
    needReadFileName();
    const writeFile = () => {
      if (!info.compressedSize) {
        recvAll(ReadStream);
        return;
      }
      if (info.compressionMethod === 8 || info.compressionMethod === 9) {
        ReadStream.pipe(zlib.createInflateRaw()).pipe(fs.createWriteStream(info.fileName));
      } else {
        ReadStream.pipe(fs.createWriteStream(info.fileName));
      }
    };
  };
  constructor(readStream: IReadStream, outputPath: string = __dirname + "/unzip/") {
    this.outputPath = outputPath;
    new RecvStream(readStream, 30, this.getLengthFn);
  }
}
