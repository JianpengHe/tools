/**
 * MySQL客户端实现
 * 提供与MySQL数据库通信的功能，支持预处理语句、流式数据传输等高级特性
 */
import { Buf, getNumberLen } from "./Buf";
import * as net from "net";
import * as stream from "stream";
import { ReliableSocket } from "./ReliableSocket";
import { RecvStream } from "./RecvStream";
import { getHash, TypedEventEmitter } from "./utils";

/**
 * MySQL专用缓冲区类
 * 扩展了基础Buf类，添加了MySQL协议特定的数据读写方法
 */
export class MysqlBuf extends Buf {
  constructor(buf?: Buffer, offset?: number) {
    super(buf, offset);
  }

  /**
   * 读取MySQL长度编码整数
   * MySQL协议中用于表示变长整数的特殊格式
   * @param offset 读取位置偏移量
   * @returns 解码后的整数值
   */
  public readIntLenenc(offset?: number): number {
    const firstByte = this.readUIntLE(1, offset);
    if (firstByte < 251) {
      return firstByte;
    }
    if (firstByte === 0xfc) {
      return this.readUIntLE(2);
    }
    if (firstByte === 0xfd) {
      return this.readUIntLE(3);
    }
    if (firstByte === 0xfe) {
      return this.readUIntLE(8);
    }
    return 0;
  }

  /**
   * 写入MySQL长度编码整数
   * @param number 要写入的整数值
   * @param offset 写入位置偏移量
   * @returns 写入后的新偏移量
   */
  public writeIntLenenc(number: number, offset?: number) {
    if (number < 251) {
      return this.writeUIntLE(number, 1, offset);
    }
    if (number < 65536) {
      this.writeUIntLE(0xfc);
      return this.writeUIntLE(number, 2, offset);
    }
    if (number < 16777216) {
      this.writeUIntLE(0xfd);
      return this.writeUIntLE(number, 3, offset);
    }
    this.writeUIntLE(0xfe);
    return this.writeUIntLE(number, 8, offset);
  }

  /**
   * 写入MySQL长度编码字符串
   * 先写入字符串长度，再写入字符串内容
   * @param string 要写入的字符串
   * @param offset 写入位置偏移量
   * @returns 写入后的新偏移量
   */
  public writeStringLenenc(string: string, offset?: number) {
    return this.writeStringPrefix(
      string,
      len => {
        this.writeIntLenenc(len);
        return undefined;
      },
      offset,
    );
  }
}

/**
 * MySQL字段类型枚举
 * 定义了MySQL支持的所有数据类型的编码
 */
export enum EMysqlFieldType {
  decimal = 0x00,
  tiny = 0x01,
  short = 0x02,
  long = 0x03,
  float = 0x04,
  double = 0x05,
  null = 0x06,
  timestamp = 0x07,
  longlong = 0x08,
  int24 = 0x09,
  date = 0x0a,
  time = 0x0b,
  datetime = 0x0c,
  year = 0x0d,
  newdate = 0x0e,
  varchar = 0x0f,
  bit = 0x10,
  json = 0xf5,
  newdecimal = 0xf6,
  enum = 0xf7,
  set = 0xf8,
  tiny_blob = 0xf9,
  medium_blob = 0xfa,
  long_blob = 0xfb,
  blob = 0xfc,
  var_string = 0xfd,
  string = 0xfe,
  geometry = 0xff,
}

/**
 * MySQL字段标志枚举
 * 定义了字段的各种属性标志位
 */
export enum EMysqlFieldFlags {
  not_flags = 0,
  not_null = 0x0001, // 字段不允许为NULL
  pri_key = 0x0002, // 字段是主键的一部分
  unique_key = 0x0004, // 字段是唯一键的一部分
  multiple_key = 0x0008, // 字段是非唯一键的一部分
  blob = 0x0010, // 字段是BLOB类型
  unsigned = 0x0020, // 字段是无符号数值类型
  zerofill = 0x0040, // 字段有ZEROFILL属性
  binary = 0x0080, // 字段是二进制数据
  enum = 0x0100, // 字段是枚举类型
  auto_increment = 0x0200, // 字段是自增的
  timestamp = 0x0400, // 字段是时间戳类型
  set = 0x0800, // 字段是集合类型
}

/**
 * MySQL连接配置接口
 * 定义连接到MySQL服务器所需的参数
 */
export type IMysqlConnect = {
  /** 数据库IP/域名 */
  host: string;
  /** 数据库端口 */
  port: number;
  /** 数据库用户 */
  user: string;
  /** 数据库密码 */
  password: string;
  /** 登录时选择的数据库 */
  database: string;
  /** 字符集 */
  character?: "utf8" | "utf8mb4";
  /** 输出是否转换成时间戳 */
  convertToTimestamp?: boolean;
};

/**
 * MySQL握手包接口
 * 服务器发送给客户端的初始握手信息
 */
export type IMysqlHandshake = {
  /** 服务器协议版本号 */
  protocol_version: number;
  /** 服务器版本信息 */
  server_version: string;
  /** 服务器线程ID */
  connection_id: number;
  /** 挑战随机数 */
  auth_plugin_data_part_1: Buffer;
  /** 服务器权能标志 */
  capability_flag_1: number;
  /** 字符编码 */
  character_set: number;
  /** 服务器状态 */
  status_flags: number;
  /** 挑战随机数2 */
  capability_flags_2: number;
  /** 认证插件数据长度 */
  auth_plugin_data_len: number;
  /** 挑战随机数2 */
  auth_plugin_data_part_2: Buffer;
  /** 认证插件名称 */
  auth_plugin_name: string;
};

/**
 * MySQL握手响应包接口
 * 客户端发送给服务器的握手响应信息
 */
export type IMysqlHandshakeRes = {
  /** 客户端权能标志 */
  capability_flags: number;
  /** 最大消息长度 */
  max_packet_size: number;
  /** 字符编码 */
  character_set: "utf8" | "utf8mb4";
  /** 用户名 */
  username: string;
  /** 挑战认证数据 */
  password: string;
  /** 数据库名称 */
  database: string;
};

/**
 * MySQL字段头信息接口
 * 描述结果集中每个字段的元数据
 */
export type IMysqlFieldHeader = {
  /** 目录名称 */
  catalog: string;
  /** 数据库名称 */
  schema: string;
  /** 数据表名称 */
  table: string;
  /** 数据表原始名称 */
  tableOrg: string;
  /** 列（字段）名称 */
  name: string;
  /** 列（字段）原始名称 */
  nameOrg: string;
  /** 字符编码 */
  characterSet: number;
  /** 列（字段）长度 */
  columnLength: number;
  /** 列（字段）类型 */
  type: EMysqlFieldType;
  /** 列（字段）标志 */
  flags: EMysqlFieldFlags;
  /** 整型值精度 */
  decimals: number;
  /** 是否是固定长度 */
  noFixedLength?: boolean;
};

/**
 * MySQL值类型
 * 定义了MySQL查询结果中可能的值类型
 */
export type IMysqlValue = number | string | Date | Buffer | null | undefined;

/**
 * MySQL执行结果接口
 * 非查询SQL执行后的结果信息
 */
export type IMysqlResult = {
  /** 受影响行数 */
  affectedRows: number;
  /** 索引ID值 */
  lastInsertId: number;
  /** 服务器状态 */
  statusFlags: number;
  /** 告警计数 */
  warningsNumber: number;
  /** 服务器消息 */
  message: string;
};

/**
 * MySQL结果集接口
 * 查询SQL执行后返回的数据结构
 */
export type IMysqlResultset = { headerInfo: IMysqlFieldHeader[]; data: IMysqlValue[][] };

/**
 * MySQL预处理结果接口
 * 预处理SQL语句后返回的信息
 */
export type IMysqlPrepareResult = {
  /** 预处理语句的ID值 */
  statementId: number;
  /** 所需字段数量 */
  columnsNum: number;
  /** 参数数量 */
  paramsNum: number;
  /** 警告数量 */
  warningCount: number;
};

/**
 * MySQL任务接口
 * 定义执行SQL的任务结构
 */
export type IMysqltask = {
  /** SQL语句 */
  sql: string;
  /** SQL参数数组 */
  params: (IMysqlValue | stream.Readable)[];
  /** 遇到不确定长度的"长数据"单元格时触发onLongData回调，开发者可以视情况返回可写流，这个单元格的值就流向这个可写流，不返回任何东西就缓存下来 */
  onLongData?: (
    len: number,
    columnInfo: IMysqlFieldHeader,
    index: number,
    receivedDataNow: IMysqlResultset,
  ) => stream.Writable | void;
  /** 执行完成后的回调函数 */
  callback: (err: Error | null, value?: IMysqlResult | IMysqlResultset) => void;
};

/**
 * MySQL事件接口
 * 定义MySQL客户端可能触发的事件
 */
export type IMysqlEvents = {
  /** 握手事件 */
  handshake: (handshake: IMysqlHandshake, handshakeRes: IMysqlHandshakeRes) => void;
  /** 登录错误事件 */
  loginError: (errNo: number, errMsg: string) => void;
  /** 连接成功事件 */
  connected: () => void;
  /** 预处理完成事件 */
  prepare: (sql: string, prepareResult: IMysqlPrepareResult) => void;
  /** 字段头信息事件 */
  headerInfo: (headerInfo: IMysqlFieldHeader, sql: string) => void;
};

/**
 * MySQL客户端类
 * 实现与MySQL服务器的通信，提供查询、预处理等功能
 */
export class Mysql extends TypedEventEmitter<IMysqlEvents> {
  /** 可靠Socket连接 */
  public reliableSocket: ReliableSocket;
  /** 读取Socket流 */
  public readSocket?: RecvStream;
  /** 当前数据库名称 */
  public dbName: string = "";
  /** 底层Socket连接 */
  private socket?: net.Socket;
  /** 连接配置信息 */
  private connectInfo: IMysqlConnect;
  /** 预处理语句映射表 */
  private prepareMap: Map<string, IMysqlPrepareResult> = new Map();
  /** 当前执行的任务 */
  private task?: IMysqltask;
  /** 任务队列 */
  private taskQueue: IMysqltask[] = [];
  /** 连接状态 */
  private connected = false;
  /** 不固定长度的类型列表 */
  private noFixedLengthType = [
    "string",
    "varchar",
    "var_string",
    "enum",
    "set",
    "long_blob",
    "medium_blob",
    "blob",
    "tiny_blob",
    "geometry",
    "bit",
    "decimal",
    "newdecimal",
  ];

  /**
   * 构造函数
   * @param connect MySQL连接配置
   */
  constructor(connect: IMysqlConnect) {
    super();
    this.connectInfo = connect;
    this.reliableSocket = new ReliableSocket(
      { host: connect.host ?? "127.0.0.1", port: connect.port ?? 3306 },
      {
        onConnect: socket => {
          this.socket = socket;
          this.readSocket = new RecvStream(socket);
          this.login();
        },
        onClose: () => {
          this.connected = false;
          this.prepareMap.clear();
        },
      },
    );
  }
  /**
   * 从MySQL服务器接收数据包
   * 先读取4字节的包头，再根据包头中的长度信息读取数据包内容
   * @returns 返回包含包头和数据包的数组，如果连接断开则返回undefined
   */
  private async recv() {
    if (!this.readSocket) {
      throw new Error("not readSocket");
    }
    const headBuf = this.readSocket.readBufferSync(4);
    const head = headBuf instanceof Promise ? await headBuf : headBuf;
    /** 连接断开 */
    if (!head) return;
    const len = head.readUIntLE(0, 3);
    if (!len) {
      return [head];
    }
    const dataBuf = this.readSocket.readBufferSync(len);
    const data = dataBuf instanceof Promise ? await dataBuf : dataBuf;
    /** 连接断开 */
    if (!data) return;
    return [head, data];
  }

  /**
   * 将日期对象转换为MySQL日期字符串格式
   * @param date 日期对象
   * @returns 格式化后的日期字符串，如 '2022-01-01 12:30:45'
   */
  private dateToString(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
      2,
      "0",
    )} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds(),
    ).padStart(2, "0")}`;
  }

  /**
   * 登录到MySQL服务器
   * 处理握手过程，包括接收服务器握手包、发送认证响应、处理认证结果
   * 支持MySQL传统认证和MySQL 8的caching_sha2_password认证方式
   */
  private async login() {
    const handshakeRawBuf = await this.recv();
    if (!handshakeRawBuf) {
      throw new Error("Disconnect");
    }
    if (!handshakeRawBuf[1]) {
      throw new Error("no login info");
    }
    const handshakeBuf = new Buf(handshakeRawBuf[1]);
    // 解析服务器发送的握手包
    const info = {
      protocol_version: handshakeBuf.readUIntLE(1),
      server_version: handshakeBuf.readString(),
      connection_id: handshakeBuf.readUIntLE(4),
      auth_plugin_data_part_1: handshakeBuf.read(8),
      capability_flag_1: handshakeBuf.readUIntLE(2, handshakeBuf.offset + 1),
      character_set: handshakeBuf.readUIntLE(1),
      status_flags: handshakeBuf.readUIntLE(2),
      capability_flags_2: handshakeBuf.readUIntLE(2),
      auth_plugin_data_len: handshakeBuf.readUIntLE(1),
      auth_plugin_data_part_2: handshakeBuf.read(handshakeBuf.lastReadValue - 9, handshakeBuf.offset + 10),
      auth_plugin_name: handshakeBuf.readString(undefined, handshakeBuf.offset + 1),
    };

    // 准备登录响应包
    const loginBuf = new Buf();
    loginBuf.writeUIntLE(0, 3);
    loginBuf.writeUIntLE(handshakeRawBuf[0][3] + 1);
    const res: IMysqlHandshakeRes = {
      capability_flags: 696973,
      max_packet_size: 3221225472,
      character_set: info.character_set === 45 ? "utf8mb4" : "utf8",
      username: this.connectInfo.user,
      password: this.connectInfo.password,
      database: this.connectInfo.database,
    };
    this.emit("handshake", info, res);

    // 写入客户端能力标志
    loginBuf.writeUIntLE(res.capability_flags, 4);
    loginBuf.writeUIntLE(res.max_packet_size, 4);
    loginBuf.writeUIntLE(res.character_set === "utf8mb4" ? 45 : 33, 1);
    loginBuf.alloc(23, 0);
    loginBuf.writeStringNUL(res.username, loginBuf.offset + 23);

    /** 是否使用MySQL8的caching_sha2_password */
    const isCachingSha2Password = info.auth_plugin_name === "caching_sha2_password";
    /** 加密方式 */
    const algorithm = isCachingSha2Password ? "sha256" : "sha1";
    /** SHA(password) */
    const password_sha = getHash(algorithm, Buffer.from(res.password));
    /** SHA(SHA(password)) */
    const password_sha_sha = getHash(algorithm, password_sha);
    /** 拼接顺序 */
    const sha_list = [info.auth_plugin_data_part_1, info.auth_plugin_data_part_2];
    if (isCachingSha2Password) {
      sha_list.unshift(password_sha_sha);
    } else {
      sha_list.push(password_sha_sha);
    }

    // 计算加密后的密码
    const password = Buffer.alloc(password_sha.length);
    getHash(algorithm, Buffer.concat(sha_list)).forEach((byte, i) => {
      password[i] = byte ^ password_sha[i];
    });

    // 写入密码和数据库名
    loginBuf.writeUIntLE(password.length, 1);
    loginBuf.write(password);
    loginBuf.writeStringNUL(res.database);
    loginBuf.writeStringNUL(info.auth_plugin_name);
    loginBuf.buffer.writeUIntLE(loginBuf.buffer.length - 4, 0, 3);

    if (this.socket?.readyState === "open") {
      // 发送登录响应包
      this.socket.write(loginBuf.buffer);
      let recvBufs: Buffer[] | undefined;
      let result: Buffer;
      if (!(recvBufs = await this.recv())) {
        /** 连接断开 */
        throw new Error("Disconnect");
      }

      result = recvBufs[1];

      // 处理MySQL 8的caching_sha2_password认证
      if (result.length === 2) {
        if (result[1] === 3) {
          if (!(recvBufs = await this.recv())) {
            /** 连接断开 */
            throw new Error("Disconnect");
          }
          result = recvBufs[1];
        } else {
          if (!this.emit("loginError", 0, "caching_sha2_password err")) {
            throw new Error(`MYSQL Login Error: caching_sha2_password`);
          }
        }
      }

      // 检查登录结果
      if (!result || result[0] !== 0) {
        const errNo = result.readUInt16LE(1);
        const errMsg = String(result.subarray(3));
        if (!this.emit("loginError", errNo, errMsg)) {
          throw new Error(`MYSQL Login Error: ${errNo} ${errMsg}`);
        }
        return;
      }

      // 登录成功，设置连接状态
      this.dbName = this.connectInfo.database || "";
      this.connected = true;
      this.emit("connected");
      this.tryToConsume();
      return;
    }
    this.socket?.end();
  }
  /**
   * 获取预处理语句的结果
   * 向MySQL服务器发送预处理请求，并解析返回的预处理结果
   * @param sql 要预处理的SQL语句
   * @returns 预处理结果，包含语句ID、列数、参数数等信息
   */
  private getPrepare(sql: string): Promise<IMysqlPrepareResult> {
    const buf = new Buf();
    buf.writeUIntLE(0x16); // 0x16是MySQL预处理命令的代码
    buf.writeStringPrefix(sql);
    return new Promise((resolve, reject) =>
      this.reliableSocket.getSocket(async sock => {
        // 分包发送预处理请求
        let len = buf.buffer.length;
        let i = 0;
        let writeLen = 0;
        while (len > 0) {
          const nowWriteLen = Math.min(0xffffff, len); // MySQL包最大长度为16MB
          len -= nowWriteLen;
          const headBuf = Buffer.alloc(4, i);
          headBuf.writeUIntLE(nowWriteLen, 0, 3);
          sock.write(Buffer.concat([headBuf, buf.buffer.subarray(writeLen, (writeLen += nowWriteLen))]));
          i++;
        }
        if (!this.readSocket) {
          throw new Error("not readSocket");
        }

        // 接收并解析预处理结果
        let prepareResult: IMysqlPrepareResult | undefined = undefined;
        let revcTimes = 0;
        while (1) {
          const headBuf = this.readSocket.readBufferSync(4);
          const head = headBuf instanceof Promise ? await headBuf : headBuf;
          if (!head) {
            /** 连接断开 */
            reject(new Error("Disconnect"));
            return;
          }
          len = head.readUIntLE(0, 3);
          if (!len) {
            reject(new Error("pid: no len?"));
            return;
          }
          const data = this.readSocket.readBufferSync(len);
          const buffer = data instanceof Promise ? await data : data;
          if (!buffer) {
            reject(new Error("no buffer"));
            return;
          }

          // 处理错误或解析预处理结果
          if (buffer[0] === 0xff) {
            // 0xff表示错误包
            reject(new Error(String(buffer.subarray(3))));
            return;
          } else if (buffer[0] === 0) {
            // 0x00表示OK包，包含预处理结果
            const buf = new Buf(buffer, 1);
            prepareResult = {
              statementId: buf.readUIntLE(4),
              columnsNum: buf.readUIntLE(2),
              paramsNum: buf.readUIntLE(2),
              warningCount: buf.readUIntLE(2, buf.offset + 1),
            };
            // 如果有列或参数，需要接收额外的包
            revcTimes += Number(prepareResult.columnsNum > 0);
            revcTimes += Number(prepareResult.paramsNum > 0);
          }
          if (
            revcTimes === 0 ||
            /** 0xfe是结束标志 EOF: header = 0xfe and length of packet < 9 */
            (buffer[0] === 0xfe && buffer.length < 9 && --revcTimes <= 0)
          ) {
            break;
          }
        }
        if (!prepareResult) {
          reject(new Error("get pid error"));
          return;
        }
        this.emit("prepare", sql, prepareResult);
        resolve(prepareResult);
      }),
    );
  }

  /**
   * 读取MySQL字段值
   * 根据字段类型从缓冲区中读取并转换为JavaScript值
   * @param type MySQL字段类型编码
   * @param buf 数据缓冲区
   * @param initLen 初始长度（对于变长类型）
   * @returns 转换后的JavaScript值
   */
  private readValue(type: number, buf: MysqlBuf, initLen?: number): IMysqlValue {
    try {
      const typeStr = EMysqlFieldType[type];
      switch (typeStr) {
        // 字符串和二进制类型
        case "string":
        case "varchar":
        case "var_string":
        case "enum":
        case "set":
        case "long_blob":
        case "medium_blob":
        case "blob":
        case "tiny_blob":
        case "geometry":
        case "bit":
        case "decimal":
        case "newdecimal":
        case "json":
          const len = initLen ?? buf.readIntLenenc();
          if (buf.buffer.length - buf.offset < len) {
            /** 如果已缓存的buffer太短不能满足len，就返回undefined */
            return undefined;
          }
          const buffer = buf.read(len);
          if (typeStr.includes("string") || typeStr === "var_string" || typeStr === "enum" || typeStr === "json") {
            return String(buffer);
          }
          return buffer;

        // 整数类型
        case "longlong": // 8字节整数
          return buf.readUIntLE(8);
        case "long": // 4字节整数
        case "int24": // 3字节整数
          return buf.readUIntLE(4);
        case "short": // 2字节整数
        case "year": // 年份
          return buf.readUIntLE(2);
        case "tiny": // 1字节整数
          return buf.readUIntLE(1);

        // 浮点数类型
        case "double": // 双精度浮点数
          return buf.read(8).readDoubleLE();
        case "float": // 单精度浮点数
          return buf.read(4).readFloatLE();

        // 日期和时间类型
        case "date":
        case "datetime":
        case "timestamp":
          const date = new Date("2000-01-01 00:00:00");
          const dateBuffer = buf.read(buf.readIntLenenc());
          switch (dateBuffer.length) {
            case 0:
              return new Date("");
            case 11: // 包含毫秒
              date.setMilliseconds(dateBuffer.readFloatLE(7));
            case 7: // 包含时分秒
              date.setSeconds(dateBuffer[6]);
              date.setMinutes(dateBuffer[5]);
              date.setHours(dateBuffer[4]);
            case 4: // 只有年月日
              date.setDate(dateBuffer[3]);
              date.setMonth(dateBuffer[2] - 1);
              date.setFullYear(dateBuffer.readInt16LE());
          }
          // 根据配置返回时间戳或日期对象
          return this.connectInfo.convertToTimestamp ? date.getTime() : date;

        case "time":
          const timeBuffer = buf.read(buf.readIntLenenc());
          let time = 0;
          switch (timeBuffer.length) {
            case 12: // 包含微秒部分
              time += timeBuffer.readFloatLE(8);
            case 8: // 不包含微秒
              time += timeBuffer[7]; // 秒
              time += timeBuffer[6] * 60; // 分
              time += timeBuffer[5] * 60 * 60; // 时
              time += timeBuffer.readInt32LE(1); // 天
              time *= timeBuffer[0] === 1 ? -1 : 1; // 符号
          }
          return time;
      }
      return null;
    } catch (e) {
      /** 如果已缓存的buffer太短不能满足len，会导致越界，就返回undefined */
      return undefined;
    }
  }

  /**
   * 尝试消费任务队列中的任务
   * 从任务队列中取出一个任务并执行，包括预处理SQL、发送参数、接收结果等完整流程
   * @param times 递归调用次数，用于防止无限递归
   */
  private async tryToConsume(times = 0) {
    // 如果未连接或当前已有任务在执行，则退出
    if (!this.connected || this.task) {
      return;
    }

    // 从队列中取出一个任务
    this.task = this.taskQueue.splice(0, 1)[0];
    if (!this.task) {
      return;
    }

    // 防止递归调用过深导致栈溢出
    if (times++ > 1000) {
      process.nextTick(() => this.tryToConsume(0));
      return;
    }

    const { sql, params, callback, onLongData } = this.task;
    const prepareMapKey = `use ${this.dbName}; ${sql}`;
    const selectDbName = sql === "USE" ? String(params[0]) : false;

    // 获取预处理语句，如果是切换数据库则使用特殊处理
    let prepare = selectDbName
      ? { statementId: 0, columnsNum: 0, paramsNum: 1, warningCount: 0 }
      : this.prepareMap.get(prepareMapKey);

    // 如果没有预处理结果，则发送预处理请求
    if (!prepare) {
      try {
        prepare = await this.getPrepare(sql);
      } catch (e: any) {
        callback(new Error(String(e?.message ?? e)));
        this.task = undefined;
        this.tryToConsume(times);
        return;
      }
      this.prepareMap.set(prepareMapKey, prepare);
    }

    // 检查参数数量是否匹配
    if (prepare.paramsNum !== params.length) {
      callback(
        new Error(
          `入参与预处理语句的参数对不上。入参数量${params.length}，需要参数${prepare.paramsNum}，预处理语句${sql}`,
        ),
      );
      this.task = undefined;
      this.tryToConsume();
      return;
    }

    // 准备执行语句的缓冲区
    const buf = new Buf();
    if (selectDbName) {
      // 如果是切换数据库命令
      buf.writeUIntLE(2);
      buf.writeStringPrefix(selectDbName, () => undefined);
      params.length = 0;
    } else {
      // 预处理语句执行
      buf.writeUIntLE(0x17); // COM_STMT_EXECUTE 命令
      buf.writeUIntLE(prepare.statementId, 4);
      buf.writeUIntLE(0); // 游标类型: 0x00=无游标, 0x01=只读, 0x02=用于更新, 0x04=可滚动
      buf.writeUIntLE(1, 4); // 迭代次数，通常为1

      // 计算NULL值位图
      buf.writeUIntLE(
        Number(
          params.reduce(
            (previousValue, currentValue, index) => Number(previousValue) + (currentValue === null ? 1 << index : 0),
            0,
          ),
        ),
        ((params.length + 7) / 8) | 0,
      );

      // 新参数绑定标志
      buf.writeUIntLE(1);
    }

    // 准备参数数据缓冲区
    const dataBuf = new MysqlBuf();

    // 获取Socket连接并发送请求
    this.reliableSocket.getSocket(async sock => {
      if (!prepare) {
        this.task = undefined;
        this.tryToConsume(times);
        return;
      }

      // 处理每个参数
      for (let index = 0; index < params.length; index++) {
        let param = params[index];

        // 根据参数类型进行不同处理
        if (typeof param === "number") {
          // 数字类型参数
          const len = getNumberLen(param, false, true);
          buf.writeUIntLE(len === 4 ? 3 : len, 2); // 类型代码
          dataBuf.writeIntLE(param, len);
          continue;
        } else if (typeof param === "object") {
          if (param instanceof Buffer) {
            // Buffer类型参数
            buf.writeUIntLE(0xfb, 2); // MYSQL_TYPE_LONG_BLOB
            dataBuf.writeIntLenenc(param.length);
            dataBuf.write(param);
            continue;
          } else if (param === null) {
            // NULL值参数
            buf.writeUIntLE(6, 2); // MYSQL_TYPE_NULL
            continue;
          } else if (param instanceof Date) {
            // 日期类型参数
            param = this.dateToString(param);
          } else if (param instanceof stream.Readable) {
            // 流类型参数，用于大数据传输
            param.pause();
            buf.writeUIntLE(0xfb, 2); // MYSQL_TYPE_LONG_BLOB
            await this.sendLongData(param, prepare.statementId, index, sock);
            continue;
          } else {
            // 其他对象转为JSON字符串
            param = JSON.stringify(param);
          }
        }

        // 字符串类型参数
        param = String(param);
        buf.writeUIntLE(0xfd, 2); // MYSQL_TYPE_VAR_STRING
        dataBuf.writeStringLenenc(param);
      }

      // 合并命令和参数数据
      const sendBuffer = Buffer.concat([buf.buffer, dataBuf.buffer]);

      // 分包发送数据
      let len = sendBuffer.length;
      let i = 0;
      let writeLen = 0;
      while (len > 0) {
        const nowWriteLen = Math.min(0xffffff, len); // MySQL包最大长度为16MB
        len -= nowWriteLen;
        const headBuf = Buffer.alloc(4, i);
        headBuf.writeUIntLE(nowWriteLen, 0, 3);
        sock.write(Buffer.concat([headBuf, sendBuffer.subarray(writeLen, (writeLen += nowWriteLen))]));
        i++;
      }

      if (!this.readSocket) {
        throw new Error("not readSocket");
      }

      // 接收和处理结果
      /** 需要接收的次数 */
      let revcTimes = 2;
      const headerInfo: IMysqlFieldHeader[] = [];
      const data: IMysqlValue[][] = [];
      let lastBuffer: Buffer | undefined;
      let recvStream: stream.Writable | undefined;
      let recvStreamLen = 0;
      /** 第几个单元格 */
      let fieldIndex = 0;
      /** 第几条记录 */
      let recordIndex = -1;

      while (1) {
        // 读取数据包头
        const headBuf = this.readSocket.readBufferSync(4);
        const head = headBuf instanceof Promise ? await headBuf : headBuf;
        if (!head) {
          /** 连接断开 */
          callback(new Error("Disconnect"));
          return;
        }
        len = head.readUIntLE(0, 3);
        if (!len) {
          callback(new Error("no len?"));
          break;
        }

        // 读取数据包内容
        const bufferdata = this.readSocket.readBufferSync(len);
        let buffer = bufferdata instanceof Promise ? await bufferdata : bufferdata;
        if (!buffer) {
          callback(new Error("no buffer"));
          break;
        }

        // 处理错误包
        if (buffer[0] === 0xff) {
          callback(new Error(String(buffer.subarray(3))));
          break;
        }

        // 处理无结果集的情况（如INSERT、UPDATE等）
        if (prepare?.columnsNum === 0) {
          const buf = new MysqlBuf(buffer);
          if (selectDbName) {
            this.dbName = selectDbName;
          }
          callback(null, {
            affectedRows: buf.readIntLenenc(1),
            lastInsertId: buf.readIntLenenc(),
            statusFlags: buf.readUIntLE(2),
            warningsNumber: buf.readUIntLE(2),
            message: buf.readString(),
          });
          break;
        }

        // 忽略结果集头部包
        if (buffer.length <= 2) {
          continue;
        }

        // 处理结束包
        if (buffer[0] === 0xfe && buffer.length < 9) {
          if (--revcTimes <= 0) {
            callback(null, { headerInfo, data });
            break;
          }
        } else if (revcTimes === 2) {
          // 处理列信息包
          const buf = new MysqlBuf(buffer);
          const info: IMysqlFieldHeader = {
            catalog: buf.readString(buf.readIntLenenc()),
            schema: buf.readString(buf.readIntLenenc()),
            table: buf.readString(buf.readIntLenenc()),
            tableOrg: buf.readString(buf.readIntLenenc()),
            name: buf.readString(buf.readIntLenenc()),
            nameOrg: buf.readString(buf.readIntLenenc()),
            characterSet: buf.readUIntLE(2, buf.offset + 1),
            columnLength: buf.readUIntLE(4),
            type: buf.readUIntLE(1),
            noFixedLength: this.noFixedLengthType.includes(EMysqlFieldType[buf.lastReadValue]),
            flags: buf.readUIntLE(2),
            decimals: buf.readUIntBE(1),
          };
          this.emit("headerInfo", info, sql);
          headerInfo.push(info);
          fieldIndex++;
        } else {
          // 处理数据行包
          const buf = new MysqlBuf(lastBuffer ? Buffer.concat([lastBuffer, buffer]) : buffer);
          lastBuffer = undefined;

          // 处理大数据流式传输
          if (recvStreamLen && recvStream) {
            const subBuffer = buf.read(recvStreamLen);
            recvStreamLen -= subBuffer.length;
            if (!recvStream.write(subBuffer) && recvStreamLen > 0) {
              // 等待流排空
              await new Promise(r => recvStream?.once("drain", () => r(0)));
            }
            if (recvStreamLen <= 0) {
              // 读完了，关闭可写流
              recvStream.end();
              recvStream = undefined;
              recvStreamLen = 0;
              // 跳过当前单元格
              fieldIndex++;
            } else {
              // 还没读完，等下一个MySQL包
              continue;
            }
          }

          // 处理新的数据行
          if (fieldIndex === headerInfo.length) {
            // 新的一条记录
            buf.offset++;
            data[++recordIndex] = [];

            // 计算NULL值位图
            let surplusHeaderLength = headerInfo.length;
            for (let nullMapIndex = 0; nullMapIndex < Math.floor((headerInfo.length + 7 + 2) / 8); nullMapIndex++) {
              const flag = buf.readUIntLE(1);
              for (let i = nullMapIndex ? 0 : 2; i < 8 && surplusHeaderLength--; i++) {
                data[recordIndex].push((flag >> i) & 1 ? null : undefined);
              }
            }
            fieldIndex = 0;
          }

          // 读取数据行中的各个字段
          for (; fieldIndex < headerInfo.length; fieldIndex++) {
            // 标记当前单元格开始的指针
            const { offset } = buf;
            // 当前单元格值的长度
            let len: number | undefined;
            if (data[recordIndex][fieldIndex] !== undefined) {
              // 如果不是undefined，说明已经有值了，或者是null
              continue;
            }

            // 处理大数据字段
            if (
              onLongData &&
              headerInfo[fieldIndex].noFixedLength &&
              // 如果开发者通过onLongData回调返回可写流，这个单元格的值就流向这个可写流
              (recvStream =
                onLongData((len = buf.readIntLenenc()), headerInfo[fieldIndex], recordIndex, { headerInfo, data }) ||
                undefined)
            ) {
              data[recordIndex][fieldIndex] = `[${EMysqlFieldType[headerInfo[fieldIndex].type]}] length:${len}`;
              buffer = buf.read(len);
              recvStreamLen = len - buffer.length;
              recvStream.write(buffer);
              if (recvStreamLen > 0) {
                // 如果一个MySQL包不能满足
                break;
              } else {
                // 关闭这个可写流
                recvStream.end();
                recvStream = undefined;
                recvStreamLen = 0;
                continue;
              }
            }

            // 读取普通字段值
            data[recordIndex][fieldIndex] = this.readValue(headerInfo[fieldIndex].type, buf, len);
            len = undefined;
            if (data[recordIndex][fieldIndex] === undefined) {
              // 数据不完整，等待下一个包
              lastBuffer = buf.buffer.subarray(offset);
              break;
            }
          }
        }
      }

      // 任务完成，处理下一个任务
      this.task = undefined;
      this.tryToConsume(times);
    });
  }

  /**
   * 发送长数据
   * 用于处理大型数据（如BLOB、TEXT等）的传输，将数据分块发送到MySQL服务器
   * 该方法将可读流中的数据读取出来，按照MySQL协议要求的格式分包发送
   * @param param 包含数据的可读流
   * @param statement_id 预处理语句ID
   * @param param_id 参数在预处理语句中的位置索引
   * @param sock 用于发送数据的Socket连接
   * @returns Promise，在数据完全发送后解析
   */
  private sendLongData = (
    param: stream.Readable,
    statement_id: number,
    param_id: number,
    sock: net.Socket,
  ): Promise<void> =>
    new Promise(resolve => {
      // 创建临时缓冲区数组，用于存储从流中读取的数据块
      const tempBufs: Buffer[] = [];
      // 记录临时缓冲区中的总字节数
      let tempBufsLen = 0;
      // 设置单个数据包的最大大小为15MB，避免超过MySQL包大小限制(16MB)
      const maxSize = 15 * 1048576;

      // 定义发送缓冲区的函数，将数据按MySQL协议格式打包并发送
      const sendBuf = (buffer: Buffer): boolean => {
        // 创建新的缓冲区对象用于构建MySQL协议包
        const buf = new Buf();
        // 写入包长度（数据长度+7字节头部）
        buf.writeUIntLE(buffer.length + 7, 3);
        // 写入包序号，固定为0
        buf.writeUIntLE(0, 1);
        // 写入命令类型，0x18表示COM_STMT_SEND_LONG_DATA命令
        buf.writeUIntLE(0x18, 1);
        // 写入预处理语句ID，4字节
        buf.writeUIntLE(statement_id, 4);
        // 写入参数ID，2字节
        buf.writeUIntLE(param_id, 2);
        // 将头部和数据合并，写入socket并返回写入结果
        return sock.write(Buffer.concat([buf.buffer, buffer]));
      };

      // 监听数据流的'data'事件，处理接收到的数据块
      param.on("data", chuck => {
        // 将数据块添加到临时缓冲区数组
        tempBufs.push(chuck);
        // 更新临时缓冲区总长度
        tempBufsLen += chuck.length;

        // 当累积的数据超过最大包大小时，进行分包发送
        while (tempBufsLen >= maxSize) {
          // 减少计数器，表示即将发送maxSize大小的数据
          tempBufsLen -= maxSize;
          // 合并所有缓冲区中的数据为一个大缓冲区
          const buffer = Buffer.concat(tempBufs);
          // 保留剩余的数据到第一个缓冲区位置
          tempBufs[0] = buffer.subarray(maxSize);
          // 重置数组长度为1，只保留剩余数据
          tempBufs.length = 1;
          // 发送最大大小的数据块，如果socket缓冲区已满（返回false）
          if (!sendBuf(buffer.subarray(0, maxSize))) {
            // 暂停数据流，防止内存溢出
            param.pause();
            // 等待socket缓冲区清空后恢复数据流
            sock.once("drain", () => param.resume());
            // 跳出循环，等待socket可写
            break;
          }
        }
      });

      // 监听数据流的'end'事件，处理所有数据接收完毕的情况
      param.on("end", () => {
        // 合并剩余的所有数据块
        const buffer = Buffer.concat(tempBufs);
        // 清空临时缓冲区数组
        tempBufs.length = 0;
        // 发送剩余的数据
        sendBuf(buffer.subarray(0, maxSize));
        // 解析Promise，表示长数据发送完成
        resolve();
      });

      // 启动数据流（如果之前被暂停）
      param.resume();
    });

  /**
   * 将结果集转换为对象数组
   * @param source 结果集
   * @returns 对象数组
   */
  public format: (source: IMysqlResultset) => { [x: string]: IMysqlValue }[] = ({ headerInfo, data }) =>
    data.map(row => headerInfo.reduce((obj, header, i) => ({ ...obj, [header.name]: row[i] }), {}));
  /**
   * 执行SQL语句
   * @param sql SQL语句
   * @param params 参数
   * @returns Promise，解析为执行结果
   */
  public query = (sql: string, params: IMysqlValue[]): Promise<IMysqlResult | { [x: string]: IMysqlValue }[]> =>
    new Promise((resolve, reject) => {
      this.taskQueue.push({
        sql,
        params,
        callback: (err, value) => {
          if (err || !value) {
            reject(err);
            return;
          }
          resolve("data" in value ? this.format(value) : value);
        },
      });
      this.tryToConsume();
    });
  /**
   * 执行原始SQL查询
   * 直接使用任务对象执行查询，允许更灵活的控制，如处理大数据流
   * @param task 查询任务对象，包含SQL语句、参数、回调函数和可选的大数据处理函数
   * @returns 当前MySQL实例，支持链式调用
   */
  public queryRaw = (task: IMysqltask) => {
    this.taskQueue.push(task);
    this.tryToConsume();
    return this;
  };
  /**
   * 切换当前数据库
   * 发送USE语句切换到指定的数据库
   * @param dbName 要切换到的数据库名称
   * @returns Promise，解析为执行结果
   */
  public selectDb = (dbName: string) => this.query("USE", [dbName]) as Promise<IMysqlResult>;
}

// 测试用例
// (async () => {
//   const mysql = new Mysql({
//     host: "127.0.0.1",
//     port: 3306,
//     user: "root",
//     password: "root123",
//     database: "information_schema",
//     convertToTimestamp: true,
//   });
//   mysql.on("handshake", handshake => {
//     console.log("handshake");
//   });
//   mysql.once("loginError", (a, b) => {
//     console.log(a, b);
//     mysql.reliableSocket.close();
//   });
//   mysql.on("connected", () => {
//     console.log("connected");
//   });
//   mysql.on("prepare", (...a) => {
//     console.log("prepare", ...a);
//   });
//   mysql.selectDb("info").then(a => {
//     console.log(a);
//   });
//   mysql
//     .query("SELECT * FROM `testnull`", [])
//     .then(a => {
//       console.log(a);
//     })
//     .catch(e => {
//       console.log("报错了");
//       console.error(e);
//     });
//   mysql
//     .query("UPDATE info.`testnull` SET `2` = ? WHERE `testnull`.`id` = ?", [-65537 * 300, 1])
//     .then(a => {
//       console.log(a);
//     })
//     .catch(e => {
//       console.log("报错了");
//       console.error(e);
//     });
//   mysql.query("DELETE FROM score.`2020` WHERE `studentId`=1 and score=1", []).then(console.log);
//   mysql.queryRaw({
//     sql: "SELECT * FROM INFO.student LIMIT ?",
//     params: [10],
//     callback(err, data) {
//       console.log(data);
//     },
//   });

//   const ignoreDB = ["information_schema", "mysql", "performance_schema"];
//   mysql
//     .query(
//       `SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,IS_NULLABLE,DATA_TYPE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE table_schema not in(${ignoreDB
//         .map(_ => "?")
//         .join(",")});`,
//       ignoreDB
//     )
//     .then(console.log);
//   const a = await mysql.query(
//     `SELECT * FROM info.student a INNER JOIN info.student b on a.studentId=b.studentId LIMIT 10`,
//     []
//   );

//   console.log(a);
//   const [result1, result2] = await Promise.all([
//     mysql.query(`SELECT * FROM INFO.student LIMIT ?`, [500]),

//     mysql.query("UPDATE info.`student` SET `createTime` = ? WHERE `student`.`studentId` = ?", [
//       "2022-02-14 15:33:39",
//       172017001,
//     ]),
//   ]);
//   console.log("result1:", result1);
//   console.log("result2:", result2);
//   const s = require("fs").createReadStream("d:/t.bin", { end: 320 * 1024 * 1024 - 1 });
//   setTimeout(async () => {
//     console.log(
//       await mysql.query("UPDATE info.`student` SET `bo` = ? WHERE `student`.`studentId` = ?", [s, "172017002"])
//     );
//   }, 1000);
//   const a2 = mysql.queryRaw({
//     sql: `SELECT * FROM info.student LIMIT 10`,
//     params: [],
//     onLongData(len, info, index, { data }) {
//       if (info.name === "bo") {
//         return require("fs").createWriteStream("t" + (data[index][2] || index) + ".bin");
//       }
//     },
//     callback(_, d) {
//       d && "data" in d && console.log(a2.format(d));
//     },
//   });
// })();
