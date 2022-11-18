/** 参考：https://users.cs.jmu.edu/buchhofp/forensics/formats/pkzip.html
 *        https://opensource.apple.com/source/zip/zip-6/unzip/unzip/proginfo/extra.fld
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { Buf } from "./Buf";
import { IReadStream } from "./utils";
import { RecvStream } from "./RecvStream";

export type IUnZipHead = {
  /** 解压文件所需 pkware最低版本 */
  version: number;
  /** 通用比特标志位(置比特0位=加密) */
  flag: number;
  /** 压缩方式 */
  compressionMethod: number;
  /** 文件最后修改时间 (参考https://learn.microsoft.com/zh-cn/windows/win32/api/winbase/nf-winbase-dosdatetimetofiletime) */
  lastModificationTime: number;
  /** 文件最后修改日期 */
  lastModificationDate: number;
  /** CRC-32校验码 */
  CRC: Buffer;
  /** 压缩后的大小 */
  compressedSize: number;
  /** 未压缩的大小 */
  uncompressedSize: number;
  /** 文件名长度 */
  fileNameLength: number;
  /** 扩展区长度 */
  extraFieldLength: number;
  /** 文件名 */
  fileName?: string;
  /** 扩展区 */
  extraField?: Buffer;
  /** 完整解压路径 */
  filePath: string;
  /** 单个文件子可读流 */
  fileRecvStream?: IReadStream;
};

export type IUnZipCentralDirectory = {
  /** 压缩所用的pkware版本 */
  versionMadeBy: number;
  /** 文件注释长度 */
  commentLength: number;
  /** 文件开始位置的磁盘编号 */
  diskNumberWhereFileStarts: number;
  /** 内部文件属性 */
  internalFileAttributes: Buffer;
  /** 外部文件属性 */
  externalFileAttributes: Buffer;
  /** 本地文件头的相对位移 */
  relativeOffsetOfLocalHeader: number;
  /** 文件注释 */
  fileComment?: string;
  /** file last modification time */
  mtime?: number;
  /** file last access time */
  atime?: number;
  /** file creation time */
  ctime?: number;
} & IUnZipHead;

export type IUnZipEOCD = {
  /** 当前磁盘编号 */
  Number_of_this_disk: number;
  /** 核心目录开始位置的磁盘编号 */
  number_of_the_disk_with_the_start_of_the_central_directory: number;
  /** 该磁盘上所记录的核心目录数量 */
  total_number_of_entries_in_the_central_directory_on_this_disk: number;
  /** 核心目录结构总数 */
  total_number_of_entries_in_the_central_directory: number;
  /** 核心目录的大小 */
  Size_of_central_directory: number;
  /** 核心目录开始位置相对于archive开始的位移 */
  offset_of_start_of_central_directory_with_respect_to_the_starting_disk_number: number;
  /** 注释长度 */
  ZIP_file_comment_length: number;
  /** 注释内容 */
  ZIP_Comment: string;
};

export class UnZip {
  private dirCache: Set<string> = new Set();
  private outputPath: string;
  private recvStream: RecvStream;
  private onFileFn?: (fileHead: IUnZipHead, recvStream: RecvStream) => void;
  private onCentralDirectoryFn?: (centralDirectory: IUnZipCentralDirectory, recvStream: RecvStream) => void;
  private onEndFn?: (EOCD: IUnZipEOCD, recvStream: RecvStream) => void;
  private zipFileHead = [
    [0x50, 0x4b, 1, 2],
    [0x50, 0x4b, 3, 4],
    [0x50, 0x4b, 5, 6],
  ];

  /** 文件流结束 */
  private fileCloseMap: Map<string, IUnZipCentralDirectory | false> = new Map();

  private extraTimeHead = Buffer.from([0x0a, 0, 0x20, 0, 0, 0, 0, 0, 1, 0, 0x18, 0]);
  private NTFSFileTimeToTimestamp: (buf: Buffer) => number = buf =>
    (buf.readUInt32LE() + buf.readUInt32LE(4) * 4294967296) / 10000 - 11644473600000;

  private getHead(type = 0, index = 0, times = 0) {
    if (times++ > 2500) {
      process.nextTick(() => this.getHead(type, index, 0));
      return;
    }

    if (index >= this.zipFileHead[type].length) {
      switch (type) {
        case 0:
          this.readCentralDirectory(times);
          return;
        case 1:
          this.readFileInfo(times);
          return;
        case 2:
          this.readEOCD();
          return;
      }
      return;
    }
    this.recvStream.readBuffer(1, ([sign]) => {
      let newType = type;
      if (index === 2) {
        for (let i = 0; i < this.zipFileHead.length; i++) {
          newType = (type + i) % this.zipFileHead.length;

          if (sign === this.zipFileHead[newType][index]) {
            this.getHead(newType, index + 1, times);
            return;
          }
        }
      } else if (sign === this.zipFileHead[newType][index]) {
        this.getHead(newType, index + 1, times);
        return;
      }
      this.getHead(0, 0, times);
    });
  }

  /** Central directory 核心目录 */
  private readCentralDirectory(times = 0) {
    this.recvStream.readBuffer(42, headerBuf => {
      const buf = new Buf(headerBuf);
      const info: IUnZipCentralDirectory = {
        versionMadeBy: buf.readUIntLE(2),
        version: buf.readUIntLE(2),
        flag: buf.readUIntLE(2),
        compressionMethod: buf.readUIntLE(2),
        lastModificationTime: buf.readUIntLE(2),
        lastModificationDate: buf.readUIntLE(2),
        CRC: buf.read(4),
        compressedSize: buf.readUIntLE(4),
        uncompressedSize: buf.readUIntLE(4),
        fileNameLength: buf.readUIntLE(2),
        filePath: "",
        extraFieldLength: buf.readUIntLE(2),
        commentLength: buf.readUIntLE(2),
        diskNumberWhereFileStarts: buf.readUIntLE(2),
        internalFileAttributes: buf.read(2),
        externalFileAttributes: buf.read(4),
        relativeOffsetOfLocalHeader: buf.readUIntLE(4),
      };

      this.recvStream.readBuffer(info.fileNameLength, fileBuf => {
        info.fileName = String(fileBuf);
        info.filePath = path.join(this.outputPath, info.fileName || "");

        /** 读取Extra field */
        this.recvStream.readBuffer(info.extraFieldLength, extraBuf => {
          info.extraField = extraBuf;

          /** 读取文件操作时间信息 */
          let start = extraBuf.indexOf(this.extraTimeHead);
          if (start >= 0 && extraBuf.length >= (start += this.extraTimeHead.length) + 24) {
            info.mtime = this.NTFSFileTimeToTimestamp(extraBuf.subarray(start, (start += 8)));
            info.atime = this.NTFSFileTimeToTimestamp(extraBuf.subarray(start, (start += 8)));
            info.ctime = this.NTFSFileTimeToTimestamp(extraBuf.subarray(start, (start += 8)));
          }
          this.recvStream.readBuffer(info.commentLength, commentBuf => {
            info.fileComment = String(commentBuf);

            /** 保证onCentralDirectoryFn在子流结束后才调用 */
            if (this.onCentralDirectoryFn) {
              if (this.fileCloseMap.has(info.filePath)) {
                this.fileCloseMap.delete(info.filePath);
                this.onCentralDirectoryFn(info, this.recvStream);
              } else if (info.compressedSize) {
                this.fileCloseMap.set(info.filePath, info);
              }
            }

            this.getHead(0, 0, times);
          });
        });
      });
    });
  }

  /**  local file header 文件头 */
  private readFileInfo(times = 0) {
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

                /** 保证onCentralDirectoryFn在子流结束后才调用 */
                info.fileRecvStream?.once("close", () => {
                  const centralDirectory = this.fileCloseMap.get(info.filePath);
                  if (this.onCentralDirectoryFn && centralDirectory) {
                    this.fileCloseMap.delete(info.filePath);
                    this.onCentralDirectoryFn(centralDirectory, this.recvStream);
                    return;
                  }
                  this.fileCloseMap.set(info.filePath, false);
                });

                /** 交付文件头信息 */
                if (this.onFileFn) {
                  this.onFileFn(info, this.recvStream);
                } else {
                  /** 如果开发者没有绑定onFile，则自动写入硬盘 */
                  info.fileRecvStream?.pipe(fs.createWriteStream(info.filePath || ""));
                }

                this.getHead();
              });
              return;
            }
            this.onFileFn && this.onFileFn(info, this.recvStream);
            this.getHead(0, 0, times);
          });
        });
      });
    });
  }

  /** End of central directory record(EOCD) 目录结束标识 */
  private readEOCD() {
    this.recvStream.readBuffer(18, headerBuf => {
      const buf = new Buf(headerBuf);
      const info: IUnZipEOCD = {
        Number_of_this_disk: buf.readUIntLE(2),
        number_of_the_disk_with_the_start_of_the_central_directory: buf.readUIntLE(2),
        total_number_of_entries_in_the_central_directory_on_this_disk: buf.readUIntLE(2),
        total_number_of_entries_in_the_central_directory: buf.readUIntLE(2),
        Size_of_central_directory: buf.readUIntLE(4),
        offset_of_start_of_central_directory_with_respect_to_the_starting_disk_number: buf.readUIntLE(4),
        ZIP_file_comment_length: buf.readUIntLE(2),
        ZIP_Comment: "",
      };
      this.recvStream.readBuffer(info.ZIP_file_comment_length, fileBuf => {
        info.ZIP_Comment = String(fileBuf);
        this.onEndFn && this.onEndFn(info, this.recvStream);
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
  constructor(readStream: IReadStream, outputPath: string = __dirname + "/unzip/") {
    this.outputPath = outputPath;
    this.recvStream = new RecvStream(readStream);
    this.getHead();
  }

  /** 读取到文件时的回调，用于自定义文件的去向，一般情况下不建议使用 */
  public onFile(callback: UnZip["onFileFn"]) {
    this.onFileFn = callback;
    return this;
  }

  /** 已完成的文件的基本信息 */
  public onCentralDirectory(callback: UnZip["onCentralDirectoryFn"]) {
    this.onCentralDirectoryFn = callback;
    return this;
  }

  /** 结束时的回调 */
  public onEnd(callback: UnZip["onEndFn"]) {
    this.onEndFn = callback;
    return this;
  }
}

// 测试用例
// console.time("time");
// process.on("exit", () => {
//   console.timeEnd("time");
//   console.log("exit");
// });

// require("https").get(
//   "https://updatecdn.meeting.qq.com/cos/302a95c9dfa9d25256c464e0af7655a7/TencentMeeting_0300000000_3.12.6.436.publish.apk",
//   res => {
//     new UnZip(res).onCentralDirectory(info => {
//       console.log(info);
//       if (info.atime && info.mtime) {
//         fs.utimes(info.filePath, info.atime / 1000, info.mtime / 1000, err => {
//           if (err) {
//             throw err;
//           }
//         });
//       }
//     });
//   }
// );

// new UnZip(fs.createReadStream("1.zip"), "d:/un")
// .onFile(info => {
//   info.fileRecvStream?.pipe(fs.createWriteStream(info.filePath));
//   delete info.fileRecvStream;
//   console.log(info);
// })
// .onCentralDirectory(info => {
//   // console.log(info);
//   if (info.atime && info.mtime) {
//     fs.utimes(info.filePath, info.atime / 1000, info.mtime / 1000, err => {
//       if (err) {
//         throw err;
//       }
//     });
//   }
// })
// .onEnd((info, s) => {
//   // s.sourceStream.resume();
//   console.log(info);
// });
