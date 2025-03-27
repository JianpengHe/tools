/**
 * ZIP文件解压模块
 * 参考：https://users.cs.jmu.edu/buchhofp/forensics/formats/pkzip.html
 *      https://opensource.apple.com/source/zip/zip-6/unzip/unzip/proginfo/extra.fld
 *
 * 本模块实现了ZIP格式文件的解析和解压功能，支持处理标准ZIP格式的压缩文件
 * 包括读取文件头、中央目录和文件内容等核心功能
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { Buf } from "./Buf";
import { IReadStream } from "./utils";
import { RecvStream } from "./RecvStream";

/**
 * ZIP文件头信息接口
 * 描述ZIP文件中单个文件的基本信息
 */
export type IUnZipHead = {
  /** 解压文件所需 pkware最低版本 */
  version: number;
  /** 通用比特标志位(置比特0位=加密) */
  flag: number;
  /** 压缩方式：0=不压缩, 8=deflate */
  compressionMethod: number;
  /** 文件最后修改时间 (参考https://learn.microsoft.com/zh-cn/windows/win32/api/winbase/nf-winbase-dosdatetimetofiletime) */
  lastModificationTime: number;
  /** 文件最后修改日期 */
  lastModificationDate: number;
  /** CRC-32校验码，用于验证文件完整性 */
  CRC: Buffer;
  /** 压缩后的大小（字节数） */
  compressedSize: number;
  /** 未压缩的大小（字节数） */
  uncompressedSize: number;
  /** 文件名长度（字节数） */
  fileNameLength: number;
  /** 扩展区长度（字节数） */
  extraFieldLength: number;
  /** 文件名 */
  fileName?: string;
  /** 扩展区数据 */
  extraField?: Buffer;
  /** 完整解压路径，包含输出目录 */
  filePath: string;
  /** 单个文件子可读流，用于读取文件内容 */
  fileRecvStream?: IReadStream;
};

/**
 * ZIP中央目录信息接口
 * 继承自IUnZipHead，包含额外的中央目录特有信息
 */
export type IUnZipCentralDirectory = {
  /** 压缩所用的pkware版本 */
  versionMadeBy: number;
  /** 文件注释长度（字节数） */
  commentLength: number;
  /** 文件开始位置的磁盘编号，用于多磁盘ZIP文件 */
  diskNumberWhereFileStarts: number;
  /** 内部文件属性 */
  internalFileAttributes: Buffer;
  /** 外部文件属性，包含文件权限等信息 */
  externalFileAttributes: Buffer;
  /** 本地文件头的相对位移，指向文件实际数据的位置 */
  relativeOffsetOfLocalHeader: number;
  /** 文件注释 */
  fileComment?: string;
  /** 文件最后修改时间（NTFS时间戳，毫秒） */
  mtime?: number;
  /** 文件最后访问时间（NTFS时间戳，毫秒） */
  atime?: number;
  /** 文件创建时间（NTFS时间戳，毫秒） */
  ctime?: number;
} & IUnZipHead;

/**
 * ZIP文件结束中央目录记录(EOCD)接口
 * 包含ZIP文件的总体信息和结构
 */
export type IUnZipEOCD = {
  /** 当前磁盘编号 */
  Number_of_this_disk: number;
  /** 核心目录开始位置的磁盘编号 */
  number_of_the_disk_with_the_start_of_the_central_directory: number;
  /** 该磁盘上所记录的核心目录数量 */
  total_number_of_entries_in_the_central_directory_on_this_disk: number;
  /** 核心目录结构总数，即ZIP中包含的文件总数 */
  total_number_of_entries_in_the_central_directory: number;
  /** 核心目录的大小（字节数） */
  Size_of_central_directory: number;
  /** 核心目录开始位置相对于archive开始的位移 */
  offset_of_start_of_central_directory_with_respect_to_the_starting_disk_number: number;
  /** 注释长度（字节数） */
  ZIP_file_comment_length: number;
  /** 注释内容 */
  ZIP_Comment: string;
};

/**
 * ZIP文件解压类
 * 负责解析ZIP文件结构并提取其中的文件
 */
export class UnZip {
  /** 目录缓存，避免重复创建相同目录 */
  private dirCache: Set<string> = new Set();
  /** 解压输出路径 */
  private outputPath: string;
  /** 接收流，用于处理ZIP文件数据 */
  private recvStream: RecvStream;
  /** 读取到文件时的回调函数 */
  private onFileFn?: (fileHead: IUnZipHead, recvStream: RecvStream) => void;
  /** 读取到中央目录时的回调函数 */
  private onCentralDirectoryFn?: (centralDirectory: IUnZipCentralDirectory, recvStream: RecvStream) => void;
  /** 读取完成时的回调函数 */
  private onEndFn?: (EOCD: IUnZipEOCD, recvStream: RecvStream) => void;

  /**
   * ZIP文件标识头
   * 0x50, 0x4b 是ZIP文件的魔数（Magic Number）
   * 后面的数字表示不同记录类型：
   * 1,2 - 中央目录记录
   * 3,4 - 本地文件头
   * 5,6 - 结束中央目录记录
   */
  private zipFileHead = [
    [0x50, 0x4b, 1, 2],
    [0x50, 0x4b, 3, 4],
    [0x50, 0x4b, 5, 6],
  ];

  /** 文件流结束映射表，用于跟踪文件解压状态 */
  private fileCloseMap: Map<string, IUnZipCentralDirectory | false> = new Map();

  /** NTFS扩展时间头标识，用于识别ZIP文件中的NTFS时间信息 */
  private extraTimeHead = Buffer.from([0x0a, 0, 0x20, 0, 0, 0, 0, 0, 1, 0, 0x18, 0]);

  /**
   * NTFS文件时间转换为时间戳的函数
   * NTFS时间是从1601年1月1日开始计算的100纳秒间隔数
   * 需要转换为UNIX时间戳（从1970年1月1日开始的毫秒数）
   */
  private NTFSFileTimeToTimestamp: (buf: Buffer) => number = buf =>
    (buf.readUInt32LE() + buf.readUInt32LE(4) * 4294967296) / 10000 - 11644473600000;

  /**
   * 读取ZIP文件头标识
   * @param type 标识类型：0=中央目录，1=文件头，2=结束标识
   * @param index 当前读取的标识字节索引
   * @param times 递归调用次数，防止无限递归
   */
  private getHead(type = 0, index = 0, times = 0) {
    // 防止无限递归，超过一定次数后使用nextTick重新调度
    if (times++ > 2500) {
      process.nextTick(() => this.getHead(type, index, 0));
      return;
    }

    // 如果已经读取完标识头的所有字节，根据类型处理不同的记录
    if (index >= this.zipFileHead[type].length) {
      switch (type) {
        case 0:
          this.readCentralDirectory(times); // 读取中央目录
          return;
        case 1:
          this.readFileInfo(times); // 读取文件信息
          return;
        case 2:
          this.readEOCD(); // 读取结束中央目录记录
          return;
      }
      return;
    }

    // 读取下一个字节并与预期标识比较
    this.recvStream.readBuffer(1, buf => {
      if (!buf) {
        throw new Error("可读流中断了，无法读标识");
      }
      const sign = buf[0];
      let newType = type;

      // 特殊处理第三个字节（索引2），因为这个字节决定了记录类型
      if (index === 2) {
        for (let i = 0; i < this.zipFileHead.length; i++) {
          newType = (type + i) % this.zipFileHead.length;

          if (sign === this.zipFileHead[newType][index]) {
            this.getHead(newType, index + 1, times);
            return;
          }
        }
      } else if (sign === this.zipFileHead[newType][index]) {
        // 如果当前字节匹配预期标识，继续读取下一个字节
        this.getHead(newType, index + 1, times);
        return;
      }

      // 如果没有匹配的标识，重新开始查找
      this.getHead(0, 0, times);
    });
  }

  /**
   * 读取中央目录记录
   * 中央目录包含ZIP文件中所有文件的元数据
   * @param times 递归调用次数
   */
  private readCentralDirectory(times = 0) {
    // 读取中央目录头（固定42字节）
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

      // 读取文件名
      this.recvStream.readBuffer(info.fileNameLength, fileBuf => {
        info.fileName = String(fileBuf);
        info.filePath = path.join(this.outputPath, info.fileName || "");

        /** 读取Extra field（扩展字段） */
        this.recvStream.readBuffer(info.extraFieldLength, extraBuf => {
          if (!extraBuf) {
            throw new Error("可读流中断了，无法读拓展区");
          }
          info.extraField = extraBuf;

          /** 从扩展字段中读取文件操作时间信息（NTFS时间格式） */
          let start = extraBuf.indexOf(this.extraTimeHead);
          if (start >= 0 && extraBuf.length >= (start += this.extraTimeHead.length) + 24) {
            // 依次读取修改时间、访问时间和创建时间
            info.mtime = this.NTFSFileTimeToTimestamp(extraBuf.subarray(start, (start += 8)));
            info.atime = this.NTFSFileTimeToTimestamp(extraBuf.subarray(start, (start += 8)));
            info.ctime = this.NTFSFileTimeToTimestamp(extraBuf.subarray(start, (start += 8)));
          }

          // 读取文件注释
          this.recvStream.readBuffer(info.commentLength, commentBuf => {
            info.fileComment = String(commentBuf);

            /** 保证onCentralDirectoryFn在子流结束后才调用 */
            if (this.onCentralDirectoryFn) {
              if (this.fileCloseMap.has(info.filePath)) {
                // 如果文件已经处理完毕，删除映射并调用回调
                this.fileCloseMap.delete(info.filePath);
                this.onCentralDirectoryFn(info, this.recvStream);
              } else if (info.compressedSize) {
                // 否则记录中央目录信息，等待文件处理完毕后调用
                this.fileCloseMap.set(info.filePath, info);
              }
            }

            // 继续查找下一个记录
            this.getHead(0, 0, times);
          });
        });
      });
    });
  }

  /**
   * 读取本地文件头信息
   * 本地文件头包含单个文件的详细信息和实际数据
   * @param times 递归调用次数
   */
  private readFileInfo(times = 0) {
    // 读取本地文件头（固定26字节）
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

      /** 读取文件名 */
      this.recvStream.readBuffer(info.fileNameLength, fileBuf => {
        info.fileName = String(fileBuf);

        /** 读取扩展字段 */
        this.recvStream.readBuffer(info.extraFieldLength, extraBuf => {
          info.extraField = extraBuf;

          /** 准备读取文件内容 */
          info.filePath = path.join(this.outputPath, info.fileName || "");
          // 确保目标目录存在
          this.mkdir(path.dirname(info.filePath), () => {
            if (info.compressedSize) {
              // 读取压缩数据
              this.recvStream.readStream(info.compressedSize, fileStream => {
                // 根据压缩方法选择解压方式
                if (info.compressionMethod === 8 || info.compressionMethod === 9) {
                  // 方法8和9使用deflate压缩
                  if (!fileStream) {
                    throw new Error("可读流中断了，无法解压缩数据正文");
                  }
                  // 使用zlib解压
                  info.fileRecvStream = fileStream.pipe(zlib.createInflateRaw());
                } else {
                  // 不压缩或其他压缩方法
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

                /** 交付文件头信息给回调函数 */
                if (this.onFileFn) {
                  this.onFileFn(info, this.recvStream);
                } else {
                  /** 如果开发者没有绑定onFile，则自动写入硬盘 */
                  info.fileRecvStream?.pipe(fs.createWriteStream(info.filePath || ""));
                }

                // 继续查找下一个记录
                this.getHead();
              });
              return;
            }
            // 处理空文件（大小为0）
            this.onFileFn && this.onFileFn(info, this.recvStream);
            this.getHead(0, 0, times);
          });
        });
      });
    });
  }

  /**
   * 读取结束中央目录记录(EOCD)
   * EOCD包含ZIP文件的总体信息，位于ZIP文件末尾
   */
  private readEOCD() {
    // 读取EOCD头（固定18字节）
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

      // 读取ZIP文件注释
      this.recvStream.readBuffer(info.ZIP_file_comment_length, fileBuf => {
        info.ZIP_Comment = String(fileBuf);
        // 调用结束回调
        this.onEndFn && this.onEndFn(info, this.recvStream);
      });
    });
  }

  /**
   * 创建目录（如果不存在）
   * @param path 要创建的目录路径
   * @param callback 创建完成后的回调函数
   */
  private mkdir(path: string, callback: () => void) {
    // 如果目录已经在缓存中，直接调用回调
    if (this.dirCache.has(path)) {
      callback();
      return;
    }
    // 递归创建目录
    fs.mkdir(path, { recursive: true }, err => {
      this.dirCache.add(path);
      callback();
    });
  }

  /**
   * 构造函数
   * @param readStream 包含ZIP数据的可读流
   * @param outputPath 解压输出路径，默认为当前目录下的unzip文件夹
   */
  constructor(readStream: IReadStream, outputPath: string = __dirname + "/unzip/") {
    this.outputPath = outputPath;
    this.recvStream = new RecvStream(readStream);
    this.getHead(); // 开始解析ZIP文件
  }

  /**
   * 读取到文件时的回调，用于自定义文件的去向
   * 一般情况下不建议使用，除非需要特殊处理文件内容
   * @param callback 回调函数，接收文件头信息和接收流
   */
  public onFile(callback: UnZip["onFileFn"]) {
    this.onFileFn = callback;
    return this;
  }

  /**
   * 已完成的文件的基本信息回调
   * 当文件完全解压后调用
   * @param callback 回调函数，接收中央目录信息和接收流
   */
  public onCentralDirectory(callback: UnZip["onCentralDirectoryFn"]) {
    this.onCentralDirectoryFn = callback;
    return this;
  }

  /**
   * 结束时的回调
   * 当整个ZIP文件解析完成时调用
   * @param callback 回调函数，接收EOCD信息和接收流
   */
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
