import { Buf } from "./Buf";
import * as net from "net";
import * as crypto from "crypto";
import * as stream from "stream";
import { ReliableSocket } from "./ReliableSocket";
import { RecvStream } from "./RecvStream";
import { TypedEventEmitter } from "./utils";

export const SHA1 = (str: Buffer) => crypto.createHash("sha1").update(str).digest();

export class MysqlBuf extends Buf {
  constructor(buf?: Buffer, offset?: number) {
    super(buf, offset);
  }
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
  public writeStringLenenc(string: string, offset?: number) {
    return this.writeStringPrefix(
      string,
      len => {
        this.writeIntLenenc(len);
        return undefined;
      },
      offset
    );
  }
}
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
export enum EMysqlFieldFlags {
  not_flags = 0,
  not_null = 0x0001,
  pri_key = 0x0002,
  unique_key = 0x0004,
  multiple_key = 0x0008,
  blob = 0x0010,
  unsigned = 0x0020,
  zerofill = 0x0040,
  binary = 0x0080,
  enum = 0x0100,
  auto_increment = 0x0200,
  timestamp = 0x0400,
  set = 0x0800,
}
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

  auth_plugin_data_len: number;
  auth_plugin_data_part_2: Buffer;
  auth_plugin_name: string;
};
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
export type IMysqlValue = number | string | Date | Buffer | null | undefined;
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
export type IMysqlResultset = { headerInfo: IMysqlFieldHeader[]; data: IMysqlValue[][] };
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
export type IMysqltask = {
  sql: string;
  params: (IMysqlValue | stream.Readable)[];
  /** 遇到不确定长度的“长数据”单元格时触发onLongData回调，开发者可以视情况返回可写流，这个单元格的值就流向这个可写流，不返回任何东西就缓存下来 */
  onLongData?: (
    len: number,
    columnInfo: IMysqlFieldHeader,
    index: number,
    receivedDataNow: IMysqlResultset
  ) => stream.Writable | void;
  callback: (err: Error | null, value?: IMysqlResult | IMysqlResultset) => void;
};
export type IMysqlEvents = {
  handshake: (handshake: IMysqlHandshake, handshakeRes: IMysqlHandshakeRes) => void;
  loginError: (errNo: number, errMsg: string) => void;
  connected: () => void;
  prepare: (sql: string, prepareResult: IMysqlPrepareResult) => void;
  headerInfo: (headerInfo: IMysqlFieldHeader, sql: string) => void;
};

export class Mysql extends TypedEventEmitter<IMysqlEvents> {
  public reliableSocket: ReliableSocket;
  public readSocket?: RecvStream;
  private socket?: net.Socket;
  private connectInfo: IMysqlConnect;
  private prepareMap: Map<string, IMysqlPrepareResult> = new Map();
  private task?: IMysqltask;
  private taskQueue: IMysqltask[] = [];
  private connected = false;
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
      }
    );
  }
  private async recv() {
    if (!this.readSocket) {
      throw new Error("not readSocket");
    }
    const headBuf = this.readSocket.readBufferSync(4);
    const head = headBuf instanceof Promise ? await headBuf : headBuf;
    const len = head.readUIntLE(0, 3);
    if (!len) {
      return [head];
    }
    const data = this.readSocket.readBufferSync(len);
    return [head, data instanceof Promise ? await data : data];
  }
  private dateToString(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
      2,
      "0"
    )} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds()
    ).padStart(2, "0")}`;
  }
  private async login() {
    const handshakeRawBuf = await this.recv();
    if (!handshakeRawBuf[1]) {
      throw new Error("no login info");
    }
    const handshakeBuf = new Buf(handshakeRawBuf[1]);
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
    loginBuf.writeUIntLE(res.capability_flags, 4);
    loginBuf.writeUIntLE(res.max_packet_size, 4);
    loginBuf.writeUIntLE(res.character_set === "utf8mb4" ? 45 : 33, 1);
    loginBuf.alloc(23, 0);
    loginBuf.writeStringNUL(res.username, loginBuf.offset + 23);
    const password_sha1 = SHA1(Buffer.from(res.password));
    const password = Buffer.alloc(password_sha1.length);
    SHA1(Buffer.concat([info.auth_plugin_data_part_1, info.auth_plugin_data_part_2, SHA1(password_sha1)])).forEach(
      (byte, i) => {
        password[i] = byte ^ password_sha1[i];
      }
    );
    loginBuf.writeUIntLE(password.length, 1);
    loginBuf.write(password);
    loginBuf.writeStringNUL(res.database);
    loginBuf.writeStringNUL(info.auth_plugin_name);
    loginBuf.buffer.writeUIntLE(loginBuf.buffer.length - 4, 0, 3);
    if (this.socket?.readyState === "open") {
      this.socket.write(loginBuf.buffer);
      const [_, result] = await this.recv();
      if (!result || result[0] !== 0) {
        const errNo = result.readUInt16LE(1);
        const errMsg = String(result.subarray(3));
        if (!this.emit("loginError", errNo, errMsg)) {
          throw new Error(`MYSQL Login Error: ${errNo} ${errMsg}`);
        }
        return;
      }
      this.connected = true;
      this.emit("connected");
      this.tryToConsume();
      //console.log(t, String(t[1]));
      return;
    }
    this.socket?.end();
  }
  private getPrepare(sql: string): Promise<IMysqlPrepareResult> {
    const buf = new Buf();
    buf.writeUIntLE(0x16);
    buf.writeStringPrefix(sql);
    return new Promise((resolve, reject) =>
      this.reliableSocket.getSocket(async sock => {
        let len = buf.buffer.length;
        let i = 0;
        let writeLen = 0;
        while (len > 0) {
          const nowWriteLen = Math.min(0xffffff, len);
          len -= nowWriteLen;
          const headBuf = Buffer.alloc(4, i);
          headBuf.writeUIntLE(nowWriteLen, 0, 3);
          sock.write(Buffer.concat([headBuf, buf.buffer.subarray(writeLen, (writeLen += nowWriteLen))]));
          i++;
        }
        if (!this.readSocket) {
          throw new Error("not readSocket");
        }
        let prepareResult: IMysqlPrepareResult | undefined = undefined;
        let revcTimes = 0;
        while (1) {
          const headBuf = this.readSocket.readBufferSync(4);
          const head = headBuf instanceof Promise ? await headBuf : headBuf;
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
          // console.log(buffer);
          if (buffer[0] === 0xff) {
            reject(new Error(String(buffer.subarray(3))));
            return;
          } else if (buffer[0] === 0) {
            const buf = new Buf(buffer, 1);
            prepareResult = {
              statementId: buf.readUIntLE(4),
              columnsNum: buf.readUIntLE(2),
              paramsNum: buf.readUIntLE(2),
              warningCount: buf.readUIntLE(2, buf.offset + 1),
            };
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
      })
    );
  }
  private readValue(type: number, buf: MysqlBuf, initLen?: number): IMysqlValue {
    try {
      const typeStr = EMysqlFieldType[type];
      switch (typeStr) {
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
          const len = initLen ?? buf.readIntLenenc();
          if (buf.buffer.length - buf.offset < len) {
            /** 如果已缓存的buffer太短不能满足len，就返回undefined */
            return undefined;
          }
          const buffer = buf.read(len);
          if (typeStr.includes("string") || typeStr === "var_string" || typeStr === "enum") {
            return String(buffer);
          }
          return buffer;
        case "longlong":
          return buf.readUIntLE(8);
        case "long":
        case "int24":
          return buf.readUIntLE(4);
        case "short":
        case "year":
          return buf.readUIntLE(2);
        case "tiny":
          return buf.readUIntLE(1);
        case "double":
          return buf.read(8).readDoubleLE();
        case "float":
          return buf.read(4).readFloatLE();
        case "date":
        case "datetime":
        case "timestamp":
          const date = new Date("2000-01-01 00:00:00");
          const dateBuffer = buf.read(buf.readIntLenenc());
          switch (dateBuffer.length) {
            case 0:
              return new Date("");
            case 11:
              date.setMilliseconds(dateBuffer.readFloatLE(7));
            case 7:
              date.setSeconds(dateBuffer[6]);
              date.setMinutes(dateBuffer[5]);
              date.setHours(dateBuffer[4]);
            case 4:
              date.setDate(dateBuffer[3]);
              date.setMonth(dateBuffer[2] - 1);
              date.setFullYear(dateBuffer.readInt16LE());
          }
          return this.connectInfo.convertToTimestamp ? date.getTime() : date;
        case "time":
          const timeBuffer = buf.read(buf.readIntLenenc());
          let time = 0;
          switch (timeBuffer.length) {
            case 12:
              time += timeBuffer.readFloatLE(8);
            case 8:
              time += timeBuffer[7];
              time += timeBuffer[6] * 60;
              time += timeBuffer[5] * 60 * 60;
              time += timeBuffer.readInt32LE(1);
              time *= timeBuffer[0] === 1 ? -1 : 1;
          }
          return time;
      }
      return null;
    } catch (e) {
      /** 如果已缓存的buffer太短不能满足len，会导致越界，就返回undefined */
      return undefined;
    }
  }
  private async tryToConsume(times = 0) {
    if (!this.connected || this.task) {
      return;
    }
    this.task = this.taskQueue.splice(0, 1)[0];
    if (!this.task) {
      return;
    }
    if (times++ > 1000) {
      process.nextTick(() => this.tryToConsume(0));
      return;
    }
    const { sql, params, callback, onLongData } = this.task;
    let prepare = this.prepareMap.get(sql);
    if (!prepare) {
      try {
        prepare = await this.getPrepare(sql);
      } catch (e: any) {
        callback(Error(String(e?.message ?? e)));
        this.task = undefined;
        this.tryToConsume(times);
        return;
      }
      this.prepareMap.set(sql, prepare);
    }
    // console.log("pid", prepare, sql, params);
    if (prepare.paramsNum !== params.length) {
      callback(
        new Error(
          `入参与预处理语句的参数对不上。入参数量${params.length}，需要参数${prepare.paramsNum}，预处理语句${sql}`
        )
      );
      this.task = undefined;
      this.tryToConsume();
      return;
    }
    const buf = new Buf();
    buf.writeUIntLE(0x17);
    buf.writeUIntLE(prepare.statementId, 4);
    buf.writeUIntLE(0); // 0x00: CURSOR_TYPE_NO_CURSOR、0x01: CURSOR_TYPE_READ_ONLY、0x02: CURSOR_TYPE_FOR_UPDATE、0x04: CURSOR_TYPE_SCROLLABLE
    buf.writeUIntLE(1, 4);
    buf.writeUIntLE(
      Number(
        params.reduce(
          (previousValue, currentValue, index) => Number(previousValue) + (currentValue === null ? 1 << index : 0),
          0
        )
      )
    );
    buf.writeUIntLE(1);
    const dataBuf = new MysqlBuf();

    this.reliableSocket.getSocket(async sock => {
      if (!prepare) {
        this.task = undefined;
        this.tryToConsume(times);
        return;
      }
      for (let index = 0; index < params.length; index++) {
        let param = params[index];
        if (typeof param === "number") {
          let len = 1;
          while (len < 8 && 2 ** (len * 8) <= param) {
            len *= 2;
          }
          if (len <= 8) {
            buf.writeUIntLE(len === 4 ? 3 : len, 2);
            dataBuf.writeUIntLE(param, len);
            continue;
          }
        } else if (typeof param === "object") {
          if (param instanceof Buffer) {
            buf.writeUIntLE(0xfb, 2);
            dataBuf.writeIntLenenc(param.length);
            dataBuf.write(param);
            continue;
          } else if (param === null) {
            buf.writeUIntLE(6, 2);
            continue;
          } else if (param instanceof Date) {
            param = this.dateToString(param);
          } else if (param instanceof stream.Readable) {
            param.pause();
            buf.writeUIntLE(0xfb, 2);
            await this.sendLongData(param, prepare.statementId, index, sock);
            continue;
          } else {
            param = JSON.stringify(param);
          }
        }
        param = String(param);
        buf.writeUIntLE(0xfd, 2);
        dataBuf.writeStringLenenc(param);
      }
      const sendBuffer = Buffer.concat([buf.buffer, dataBuf.buffer]);
      let len = sendBuffer.length;
      let i = 0;
      let writeLen = 0;
      while (len > 0) {
        const nowWriteLen = Math.min(0xffffff, len);
        len -= nowWriteLen;
        const headBuf = Buffer.alloc(4, i);
        headBuf.writeUIntLE(nowWriteLen, 0, 3);
        sock.write(Buffer.concat([headBuf, sendBuffer.subarray(writeLen, (writeLen += nowWriteLen))]));
        i++;
      }
      if (!this.readSocket) {
        throw new Error("not readSocket");
      }
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
        const headBuf = this.readSocket.readBufferSync(4);
        const head = headBuf instanceof Promise ? await headBuf : headBuf;
        len = head.readUIntLE(0, 3);
        if (!len) {
          callback(new Error("no len?"));
          break;
        }
        const bufferdata = this.readSocket.readBufferSync(len);
        let buffer = bufferdata instanceof Promise ? await bufferdata : bufferdata;
        if (!buffer) {
          callback(new Error("no buffer"));
          break;
        }

        if (buffer[0] === 0xff) {
          callback(new Error(String(buffer.subarray(3))));
          break;
        }
        /** 无结果集 */
        if (prepare?.columnsNum === 0) {
          const buf = new MysqlBuf(buffer);
          callback(null, {
            affectedRows: buf.readIntLenenc(1),
            lastInsertId: buf.readIntLenenc(),
            statusFlags: buf.readUIntLE(2),
            warningsNumber: buf.readUIntLE(2),
            message: buf.readString(),
          });
          break;
        }
        /** 忽略第一个[Result Set Header] */
        if (buffer.length <= 2) {
          continue;
        }
        /** 结束包 */
        if (buffer[0] === 0xfe && buffer.length < 9) {
          if (--revcTimes <= 0) {
            callback(null, { headerInfo, data });
            break;
          }
        } else if (revcTimes === 2) {
          /** 读取列信息 */
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
          /** 读取行数据 */
          const buf = new MysqlBuf(lastBuffer ? Buffer.concat([lastBuffer, buffer]) : buffer);
          lastBuffer = undefined;

          /** 如果存在可写流 */
          if (recvStreamLen && recvStream) {
            const subBuffer = buf.read(recvStreamLen);
            recvStreamLen -= subBuffer.length;
            if (!recvStream.write(subBuffer) && recvStreamLen > 0) {
              // console.log("等待写入流，剩余", recvStreamLen);
              await new Promise(r => recvStream?.once("drain", () => r(0)));
            }
            if (recvStreamLen <= 0) {
              /** 读完了，关闭可写流 */
              recvStream.end();
              recvStream = undefined;
              recvStreamLen = 0;
              /** 跳过当前单元格 */
              fieldIndex++;
            } else {
              /** 还没读完的话，等下一个MySQL包 */
              continue;
            }
          }
          if (fieldIndex === headerInfo.length) {
            /** 新的一条记录 */
            buf.offset++;
            data[++recordIndex] = [];
            /** 计算空位图 */

            /** 剩余列数 */
            let surplusHeaderLength = headerInfo.length;
            for (let nullMapIndex = 0; nullMapIndex < Math.floor((headerInfo.length + 7 + 2) / 8); nullMapIndex++) {
              const flag = buf.readUIntLE(1);
              for (let i = nullMapIndex ? 0 : 2; i < 8 && surplusHeaderLength--; i++) {
                data[recordIndex].push((flag >> i) & 1 ? null : undefined);
              }
            }
            /** 计算空位图END */
            fieldIndex = 0;
          }
          /** 读取剩余的单元格 */
          for (; fieldIndex < headerInfo.length; fieldIndex++) {
            /** 标记当前单元格开始的指针 */
            const { offset } = buf;
            /** 当前单元格值的长度 */
            let len: number | undefined;
            if (data[recordIndex][fieldIndex] !== undefined) {
              /** 如果不是undefined，说明已经有值了，或者是null */
              continue;
            }

            if (
              onLongData &&
              headerInfo[fieldIndex].noFixedLength &&
              /** 如果开发者通过onLongData回调返回可写流，这个单元格的值就流向这个可写流 */
              (recvStream =
                onLongData((len = buf.readIntLenenc()), headerInfo[fieldIndex], recordIndex, { headerInfo, data }) ||
                undefined)
            ) {
              data[recordIndex][fieldIndex] = `[${EMysqlFieldType[headerInfo[fieldIndex].type]}] length:${len}`;
              buffer = buf.read(len);
              recvStreamLen = len - buffer.length;
              recvStream.write(buffer);
              if (recvStreamLen > 0) {
                /** 如果一个MySQL包不能满足 */
                break;
              } else {
                /** 关闭这个可写流 */
                recvStream.end();
                recvStream = undefined;
                recvStreamLen = 0;
                continue;
              }
            }

            data[recordIndex][fieldIndex] = this.readValue(headerInfo[fieldIndex].type, buf, len);
            len = undefined;
            if (data[recordIndex][fieldIndex] === undefined) {
              // console.log("残余");
              lastBuffer = buf.buffer.subarray(offset);
              break;
            }
          }
        }
      }
      this.task = undefined;
      this.tryToConsume(times);
    });
  }
  private sendLongData = (
    param: stream.Readable,
    statement_id: number,
    param_id: number,
    sock: net.Socket
  ): Promise<void> =>
    new Promise(resolve => {
      const tempBufs: Buffer[] = [];
      let tempBufsLen = 0;
      const maxSize = 15 * 1048576;
      const sendBuf = (buffer: Buffer): boolean => {
        const buf = new Buf();
        buf.writeUIntLE(buffer.length + 7, 3);
        buf.writeUIntLE(0, 1);
        buf.writeUIntLE(0x18, 1);
        buf.writeUIntLE(statement_id, 4);
        buf.writeUIntLE(param_id, 2);
        return sock.write(Buffer.concat([buf.buffer, buffer]));
      };
      param.on("data", chuck => {
        tempBufs.push(chuck);
        tempBufsLen += chuck.length;

        while (tempBufsLen >= maxSize) {
          tempBufsLen -= maxSize;
          const buffer = Buffer.concat(tempBufs);
          tempBufs[0] = buffer.subarray(maxSize);
          tempBufs.length = 1;
          if (!sendBuf(buffer.subarray(0, maxSize))) {
            param.pause();
            sock.once("drain", () => param.resume());
            break;
          }
        }
      });
      param.on("end", () => {
        const buffer = Buffer.concat(tempBufs);
        tempBufs.length = 0;
        sendBuf(buffer.subarray(0, maxSize));
        resolve();
      });
      param.resume();
    });
  public format: (source: IMysqlResultset) => { [x: string]: IMysqlValue }[] = ({ headerInfo, data }) =>
    data.map(row => headerInfo.reduce((obj, header, i) => ({ ...obj, [header.name]: row[i] }), {}));
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
  public queryRaw = (task: IMysqltask) => {
    this.taskQueue.push(task);
    return this;
  };
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
// mysql
//   .query("SELECT * FROM inf.`testnull`", [])
//   .then(a => {
//     console.log(a);
//   })
//   .catch(e => {
//     console.log("报错了");
//     console.error(e);
//   });
// mysql
//   .query("UPDATE info.`testnull` SET `2` = ? WHERE `testnull`.`id` = ?", [null, 1])
//   .then(a => {
//     console.log(a);
//   })
//   .catch(e => {
//     console.log("报错了");
//     console.error(e);
//   });
// mysql.query("DELETE FROM score.`2020` WHERE `studentId`=1 and score=1", []).then(console.log);
// mysql.queryRaw({
//   sql: "SELECT * FROM INFO.student LIMIT ?",
//   params: [10],
//   callback(err, data) {
//     console.log(data);
//   },
// });

// const ignoreDB = ["information_schema", "mysql", "performance_schema"];
// mysql
//   .query(
//     `SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,IS_NULLABLE,DATA_TYPE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE table_schema not in(${ignoreDB
//       .map(_ => "?")
//       .join(",")});`,
//     ignoreDB
//   )
//   .then(console.log);
// const a = await mysql.query(
//   `SELECT * FROM info.student a INNER JOIN info.student b on a.studentId=b.studentId LIMIT 10`,
//   []
// );

// console.log(a);
// const [result1, result2] = await Promise.all([
//   mysql.query(`SELECT * FROM INFO.student LIMIT ?`, [500]),

//   mysql.query("UPDATE info.`student` SET `createTime` = ? WHERE `student`.`studentId` = ?", [
//     "2022-02-14 15:33:39",
//     172017001,
//   ]),
// ]);
// console.log("result1:", result1);
// console.log("result2:", result2);
// const s = require("fs").createReadStream("d:/t.bin", { end: 320 * 1024 * 1024 - 1 });
// setTimeout(async () => {
//   console.log(
//     await mysql.query("UPDATE info.`student` SET `bo` = ? WHERE `student`.`studentId` = ?", [s, "172017002"])
//   );
// }, 1000);
//   const a = mysql.queryRaw({
//     sql: `SELECT * FROM info.student LIMIT 10`,
//     params: [],
//     onLongData(len, info, index, { data }) {
//       if (info.name === "bo") {
//         return require("fs").createWriteStream("t" + (data[index][2] || index) + ".bin");
//       }
//     },
//     callback(_, d) {
//       d && "data" in d && console.log(a.format(d));
//     },
//   });
// })();
