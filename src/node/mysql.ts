import { Buf } from "./Buf";
import { IGetLengthFn, RecvAll, RecvStream } from "./RecvStream";
import * as net from "net";
import * as crypto from "crypto";
export const SHA1 = (str: Buffer) => crypto.createHash("sha1").update(str).digest();

export type IConnect = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
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
      return this.readUIntLE(4);
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
    if (number < 4294967296) {
      this.writeUIntLE(0xfd);
      return this.writeUIntLE(number, 4, offset);
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
export class Mysql {
  public socket: net.Socket;
  public connectInfo: IConnect;
  private handshakeDone: boolean;
  private callbackQueue: (() => void)[];
  private recvDataQueue: Buffer[];
  public handshake: Promise<void>;
  constructor(connect: IConnect) {
    this.connectInfo = connect;
    this.socket = net.connect({ host: connect.host, port: connect.port }, () => new RecvStream(this.socket, 5, this.recv));
    this.handshakeDone = false;
    this.callbackQueue = [];
    this.recvDataQueue = [];
    this.handshake = new Promise(resolve => {
      this.callbackQueue.push(() => resolve());
    });
    setInterval(() => console.log(this.socket.readableLength), 1000);
  }

  private recv: IGetLengthFn = async (buffer, readBufferFn) => {
    const buf = new Buf(buffer);
    const len = buf.readUIntLE(3);
    const index = buf.readUIntLE(1);
    const type = buf.readUIntLE(1);
    const dateBuffer = await RecvAll(readBufferFn(len - 1));
    // OK 响应报文	0x00
    // Error 响应报文	0xFF
    // Result Set 报文	0x01 - 0xFA
    // Field 报文	0x01 - 0xFA
    // Row Data 报文	0x01 - 0xFA
    // EOF 报文	0xFE
    console.log("↓\t", "type", type, "index", index, dateBuffer, this.socket.readableLength);
    if (type === 0xff) {
      const errBuf = new Buf(dateBuffer);
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
        this.handshakeFn(dateBuffer, index);
      }
      return;
    }
    if (type === 0xfe && dateBuffer.length < 8) {
      this.recvDataQueue.push(Buffer.allocUnsafe(0));
      this.recvQuery();
      return;
    }
    this.recvDataQueue.push(Buffer.concat([Buffer.allocUnsafe(1).fill(type), dateBuffer]));
  };
  private recvQuery() {
    const callback = this.callbackQueue.splice(0, 1)[0];
    if (callback) {
      callback();
    }
    this.recvDataQueue.length = 0;
  }
  public prepare(prepareSql: string): Promise<number> {
    if (!this.handshakeDone) {
      throw new TypeError("未登录成功");
    }
    this.send(new Buf().writeUIntLE(0x16).writeStringPrefix(prepareSql).buffer, 0);
    return new Promise(resolve => {
      this.callbackQueue.push(() => {
        resolve(this.recvDataQueue[0].readUInt32LE(1));
      });
      this.callbackQueue.push(() => {});
    });
  }
  public execute(prepareId: number, params: any[]) {
    const buf = new Buf();
    buf.writeUIntLE(0x17);
    buf.writeUIntLE(prepareId, 4);
    buf.writeUIntLE(0);
    buf.writeUIntLE(1, 4);
    buf.writeUIntLE(0);
    buf.writeUIntLE(1);
    const dataBuf = new MysqlBuf();
    params.forEach(param => {
      switch (typeof param) {
        case "number":
          buf.writeUIntLE(3).writeUIntLE(0);
          dataBuf.writeUIntLE(param, 4);
          break;
        case "string":
          buf.writeUIntLE(0xfd).writeUIntLE(0);
          dataBuf.writeStringLenenc(param);
          break;
      }
    });
    this.send(Buffer.concat([buf.buffer, dataBuf.buffer]), 0);
    return this.readResultset();
  }
  private readResultset() {
    return new Promise(resolve => {
      const arr: Buffer[] = [];
      this.callbackQueue.push(() => arr.push(...this.recvDataQueue));
      this.callbackQueue.push(() => {
        arr.push(...this.recvDataQueue);
        let buffer = arr.splice(0, 1)[0];
        // const rowNum = buffer[0];
        // read header
        const headerInfo: {
          catalog: string;
          schema: string;
          table: string;
          org_table: string;
          name: string;
          org_name: string;
          characterSet: number;
          columnLength: number;
          type: IFieldType;
          flags: IFieldFlags;
          decimals: number;
        }[] = [];
        const data: any[] = [];
        while ((buffer = arr.splice(0, 1)[0])?.length) {
          const buf = new MysqlBuf(buffer);
          headerInfo.push({
            catalog: buf.readString(buf.readIntLenenc()),
            schema: buf.readString(buf.readIntLenenc()),
            table: buf.readString(buf.readIntLenenc()),
            org_table: buf.readString(buf.readIntLenenc()),
            name: buf.readString(buf.readIntLenenc()),
            org_name: buf.readString(buf.readIntLenenc()),
            characterSet: buf.readUIntLE(2, buf.offset + 1),
            columnLength: buf.readUIntLE(4),
            type: buf.readUIntLE(1),
            flags: buf.readUIntLE(2),
            decimals: buf.readUIntBE(1),
          });
        }
        console.log(headerInfo);
        while ((buffer = arr.splice(0, 1)[0])?.length) {
          const buf = new MysqlBuf(buffer);
          const rowData: any[] = [];
          buf.offset += Math.floor((headerInfo.length + 7 + 2) / 8) + 1;
          headerInfo.forEach(({ type }) => rowData.push(this.readValue(type, buf)));
          data.push(rowData);
        }
        console.log(data);
      });
    });
  }
  public readValue(type: number, buf: MysqlBuf) {
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
    head.writeIntLE(buf.length, 0, 3);
    head[3] = index;
    console.log("↑\t", "head", head, "buf", buf);
    this.socket.write(Buffer.concat([head, buf]));
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
    console.log(info);
    const loginBuf = new Buf();
    loginBuf.writeUIntLE(696973, 4);
    loginBuf.writeUIntLE(3221225472, 4);
    loginBuf.writeUIntLE(info.character_set, 1);
    loginBuf.alloc(23, 0);
    loginBuf.writeStringNUL(this.connectInfo.user, loginBuf.offset + 23);
    const password_sha1 = SHA1(Buffer.from(this.connectInfo.password));
    const password = Buffer.alloc(password_sha1.length);
    SHA1(Buffer.concat([info.auth_plugin_data_part_1, info.auth_plugin_data_part_2, SHA1(password_sha1)])).forEach((byte, i) => {
      // tslint:disable-next-line: no-bitwise
      password[i] = byte ^ password_sha1[i];
    });
    loginBuf.writeUIntLE(password.length, 1);
    loginBuf.write(password);
    loginBuf.writeStringNUL(this.connectInfo.database);
    loginBuf.writeStringNUL(info.auth_plugin_name);
    // loginBuf.offset = 0;
    // const info2 = {
    //   capability_flags: loginBuf.read(4),
    //   max_packet_size: loginBuf.readUIntLE(4),
    //   character_set: loginBuf.readUIntLE(1) === 33 ? "utf8_general_ci" : "unknow",
    //   username: loginBuf.readString(undefined, loginBuf.offset + 23),
    //   password: loginBuf.read(loginBuf.readUIntLE(1)),
    //   database: loginBuf.readString(),
    //   auth_plugin_name: loginBuf.readString(),
    // };
    // console.log(info2);
    this.send(loginBuf.buffer, index + 1);
  }
}
