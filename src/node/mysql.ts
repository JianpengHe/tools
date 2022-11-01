import { Buf } from "./Buf";
import { IGetLengthFn, RecvStream } from "./RecvStream";
import * as net from "net";
import * as crypto from "crypto";
import { recvAll } from "./RecvBuf";
const showTCPpacket = 0;
const Log = (...msg) => {
  //  console.log(...msg);
};
export const SHA1 = (str: Buffer) => crypto.createHash("sha1").update(str).digest();

export type IConnect = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  character?: "utf8" | "utf8mb4";
};
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
export enum IFieldType {
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
export enum IFieldFlags {
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
export type IFieldHeader = {
  catalog: string;
  schema: string;
  table: string;
  tableOrg: string;
  name: string;
  nameOrg: string;
  characterSet: number;
  columnLength: number;
  type: IFieldType;
  flags: IFieldFlags;
  decimals: number;
};
export type IValue = number | string | Date | Buffer | null;
export type IResult = {
  affectedRows: number;
  lastInsertId: number;
  statusFlags: number;
  warningsNumber: number;
  message: string;
};
export type IResultset = { headerInfo: IFieldHeader[]; data: IValue[][] };
export type IPrepareResult = {
  status: number;
  statementId: number;
  columnsNum: number;
  paramsNum: number;
  warningCount: number;
  hasResultSet: boolean;
};
export class Mysql {
  public socket: net.Socket;
  public connectInfo: IConnect;
  private handshakeDone: boolean;
  private callbackQueue: (() => void)[];
  private recvDataQueue: Buffer[];
  private character: "utf8" | "utf8mb4";
  public handshake: Promise<void>;
  constructor(connect: IConnect) {
    this.connectInfo = connect;
    this.socket = net.connect(
      { host: connect.host, port: connect.port },
      () => new RecvStream(this.socket, 5, this.recv)
    );
    this.handshakeDone = false;
    this.lastRecvLen = 0;
    this.callbackQueue = [];
    this.recvDataQueue = [];
    this.character = connect.character || "utf8mb4";
    this.handshake = new Promise(resolve => {
      this.callbackQueue.push(() => resolve());
    });
    // setInterval(() => Log(this.socket.readableLength, this.callbackQueue), 1000);
  }
  private lastRecvLen: number;
  private recv: IGetLengthFn = async (buffer, readBufferFn) => {
    const buf = new Buf(buffer);
    const len = buf.readUIntLE(3);
    const { lastRecvLen } = this;
    this.lastRecvLen = len;
    const index = buf.readUIntLE(1);
    const type = buf.readUIntLE(1);
    const dataBuffer = await recvAll(readBufferFn(len - 1));
    // OK 响应报文	0x00
    // Error 响应报文	0xFF
    // Result Set 报文	0x01 - 0xFA
    // Field 报文	0x01 - 0xFA
    // Row Data 报文	0x01 - 0xFA
    // EOF 报文	0xFE
    if (showTCPpacket) {
      console.log(
        "\x1B[32m↓\tlen\x1B[0m",
        len,
        "\x1B[32mtype\x1B[0m",
        type,
        "index",
        index,
        dataBuffer,
        this.socket.readableLength
      );
    }
    if (type === 0xff) {
      const errBuf = new Buf(dataBuffer);
      const code = errBuf.readUIntLE(2);
      const msg = errBuf.readString();
      console.log(code, msg);
      return;
    }
    if (!this.handshakeDone) {
      if (type === 0) {
        this.handshakeDone = true;
        this.recvQuery();
        this.recvDataQueue.length = 0;
      } else {
        this.handshakeFn(dataBuffer, index);
      }
      return;
    }
    if (type === 0xfe && dataBuffer.length < 8) {
      this.recvDataQueue.push(Buffer.allocUnsafe(0));
      this.recvQuery();
      return;
    }
    if (lastRecvLen === 0xffffff) {
      this.recvDataQueue[this.recvDataQueue.length - 1] = Buffer.concat([
        this.recvDataQueue[this.recvDataQueue.length - 1],
        Buffer.allocUnsafe(1).fill(type),
        dataBuffer,
      ]);
    } else {
      this.recvDataQueue.push(Buffer.concat([Buffer.allocUnsafe(1).fill(type), dataBuffer]));
    }
    if (type === 0 && index === 1 && this.recvDataQueue.length === 1) {
      this.recvQuery();
    }
  };
  private recvQuery() {
    const callback = this.callbackQueue.splice(0, 1)[0];
    if (callback) {
      callback();
    } else {
      throw new TypeError("未设置回调！！！");
    }
    this.recvDataQueue.length = 0;
  }
  public prepare(prepareSql: string): Promise<IPrepareResult> {
    if (!this.handshakeDone) {
      throw new TypeError("未登录成功");
    }
    return new Promise(resolve => {
      const readParamsType = () => Log("readParamsType", prepareSql, this.callbackQueue, this.recvDataQueue);
      const readColumnsType = () => Log("readColumnsType", prepareSql, this.callbackQueue, this.recvDataQueue);
      const prepare = () => {
        Log("解决准备", this.recvDataQueue, this.callbackQueue);
        const buf = new Buf(this.recvDataQueue[0]);
        const prepareResult: IPrepareResult = {
          status: buf.readUIntLE(1),
          statementId: buf.readUIntLE(4),
          columnsNum: buf.readUIntLE(2),
          paramsNum: buf.readUIntLE(2),
          warningCount: buf.readUIntLE(2, 1),
          hasResultSet: false,
        };
        if (prepareResult.paramsNum > 0) {
          this.callbackQueue.unshift(readParamsType);
        }
        if (prepareResult.columnsNum > 0) {
          this.callbackQueue.unshift(readColumnsType);
          prepareResult.hasResultSet = true;
        }
        Log("prepare", prepareSql, this.callbackQueue, this.recvDataQueue);
        resolve(prepareResult);
      };
      this.callbackQueue.push(prepare);
      this.send(new Buf().writeUIntLE(0x16).writeStringPrefix(prepareSql).buffer, 0);
    });
  }
  public execute(prepareResult: IPrepareResult, params: IValue[]) {
    const buf = new Buf();
    buf.writeUIntLE(0x17);
    buf.writeUIntLE(prepareResult.statementId, 4);
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
    params.forEach(param => {
      if (typeof param === "number") {
        let len = 1;
        while (len < 8 && 2 ** (len * 8) <= param) {
          len *= 2;
        }
        if (len <= 8) {
          buf.writeUIntLE(len === 4 ? 3 : len, 2);
          dataBuf.writeUIntLE(param, len);
          return;
        }
      } else if (typeof param === "object") {
        if (param instanceof Buffer) {
          buf.writeUIntLE(0xfb, 2);
          dataBuf.writeIntLenenc(param.length);
          dataBuf.write(param);
          return;
        } else if (param === null) {
          buf.writeUIntLE(6, 2);
          return;
        } else if (param instanceof Date) {
          param = this.dateToString(param);
        } else {
          param = JSON.stringify(param);
        }
      }
      param = String(param);
      buf.writeUIntLE(0xfd, 2);
      dataBuf.writeStringLenenc(param);
    });

    return this.readResultset(Buffer.concat([buf.buffer, dataBuf.buffer]), prepareResult, 0);
  }
  public dateToString(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
      2,
      "0"
    )} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds()
    ).padStart(2, "0")}`;
  }
  private readResultset(sendBuf: Buffer, prepareResult: IPrepareResult, index: number): Promise<IResultset | IResult> {
    return new Promise(resolve => {
      const arr: Buffer[] = [];
      this.callbackQueue.push(() => {
        if (!prepareResult.hasResultSet) {
          Log("无结果集");
          const buf = new MysqlBuf(this.recvDataQueue[0]);
          resolve({
            affectedRows: buf.readIntLenenc(1),
            lastInsertId: buf.readIntLenenc(),
            statusFlags: buf.readUIntLE(2),
            warningsNumber: buf.readUIntLE(2),
            message: buf.readString(),
          });
          return;
        }
        Log("有结果集");
        arr.push(...this.recvDataQueue);
        this.callbackQueue.unshift(() => {
          arr.push(...this.recvDataQueue);
          Log("arr", arr);
          let buffer = arr.splice(0, 1)[0];
          // read header
          const headerInfo: IFieldHeader[] = [];
          const data: IValue[][] = [];
          while ((buffer = arr.splice(0, 1)[0])?.length) {
            const buf = new MysqlBuf(buffer);
            headerInfo.push({
              catalog: buf.readString(buf.readIntLenenc()),
              schema: buf.readString(buf.readIntLenenc()),
              table: buf.readString(buf.readIntLenenc()),
              tableOrg: buf.readString(buf.readIntLenenc()),
              name: buf.readString(buf.readIntLenenc()),
              nameOrg: buf.readString(buf.readIntLenenc()),
              characterSet: buf.readUIntLE(2, buf.offset + 1),
              columnLength: buf.readUIntLE(4),
              type: buf.readUIntLE(1),
              flags: buf.readUIntLE(2),
              decimals: buf.readUIntBE(1),
            });
          }
          Log(headerInfo);
          while ((buffer = arr.splice(0, 1)[0])?.length) {
            const buf = new MysqlBuf(buffer);
            const rowData: IValue[] = [];
            const nullMap = buf
              .readUIntLE(Math.floor((headerInfo.length + 7 + 2) / 8), 1)
              .toString(2)
              .split("")
              .map(bit => Number(bit))
              .reverse();
            headerInfo.forEach(({ type }, i) => rowData.push(nullMap[i + 2] ? null : this.readValue(type, buf)));
            data.push(rowData);
          }
          Log(data);
          resolve({ headerInfo, data });
        });
      });
      this.send(sendBuf, index);
    });
  }
  public resultsetToObj(resultset: IResultset) {
    return resultset.data.map(row => {
      const obj: { [x: string]: IValue } = {};
      row.forEach((value, index) => {
        obj[resultset.headerInfo[index].name] = value;
      });
      return obj;
    });
  }
  public readValue(type: number, buf: MysqlBuf): IValue {
    const typeStr = IFieldType[type];
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
        const len = buf.readIntLenenc();
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
        return date;
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
  }
  private send(buf: Buffer, index: number) {
    const head = Buffer.alloc(4);
    const { length } = buf;
    const thisTimeSendLen = Math.min(0xffffff, length);
    head.writeUIntLE(thisTimeSendLen, 0, 3);
    head[3] = index;
    if (showTCPpacket) {
      console.log("\x1B[31m↑\thead\x1B[0m", head, "\x1B[31mbuf\x1B[0m", buf.slice(0, thisTimeSendLen));
    }
    this.socket.write(Buffer.concat([head, buf.slice(0, thisTimeSendLen)]));
    if (length !== thisTimeSendLen || length === 0xffffff) {
      this.send(buf.slice(thisTimeSendLen), index + 1);
    }
  }
  private handshakeFn(buffer: Buffer, index: number) {
    const handshakeBuf = new Buf(buffer);
    const info = {
      server_version: handshakeBuf.readString(),
      connection_id: handshakeBuf.readUIntLE(4),
      auth_plugin_data_part_1: handshakeBuf.read(8),
      capability_flag_1: handshakeBuf.read(2, handshakeBuf.offset + 1),
      character_set: handshakeBuf.readUIntLE(1),
      status_flags: handshakeBuf.read(2),
      capability_flags_2: handshakeBuf.read(2),
      auth_plugin_data_len: handshakeBuf.readUIntLE(1),
      auth_plugin_data_part_2: handshakeBuf.read(handshakeBuf.lastReadValue - 9, handshakeBuf.offset + 10),
      auth_plugin_name: handshakeBuf.readString(undefined, handshakeBuf.offset + 1),
    };
    Log(info);
    const loginBuf = new Buf();
    loginBuf.writeUIntLE(696973, 4);
    loginBuf.writeUIntLE(3221225472, 4);
    loginBuf.writeUIntLE(this.character === "utf8" ? 33 : 45, 1);
    loginBuf.alloc(23, 0);
    loginBuf.writeStringNUL(this.connectInfo.user, loginBuf.offset + 23);
    const password_sha1 = SHA1(Buffer.from(this.connectInfo.password));
    const password = Buffer.alloc(password_sha1.length);
    SHA1(Buffer.concat([info.auth_plugin_data_part_1, info.auth_plugin_data_part_2, SHA1(password_sha1)])).forEach(
      (byte, i) => {
        password[i] = byte ^ password_sha1[i];
      }
    );
    loginBuf.writeUIntLE(password.length, 1);
    loginBuf.write(password);
    loginBuf.writeStringNUL(this.connectInfo.database);
    loginBuf.writeStringNUL(info.auth_plugin_name);
    loginBuf.offset = 0;
    const info2 = {
      capability_flags: loginBuf.read(4),
      max_packet_size: loginBuf.readUIntLE(4),
      character_set: loginBuf.readUIntLE(1) === 33 ? "utf8" : "utf8mb4",
      username: loginBuf.readString(undefined, loginBuf.offset + 23),
      password: loginBuf.read(loginBuf.readUIntLE(1)),
      database: loginBuf.readString(),
      auth_plugin_name: loginBuf.readString(),
    };
    Log(info2);
    this.send(loginBuf.buffer, index + 1);
  }
}
