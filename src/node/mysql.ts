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
export class Mysql {
  public socket: net.Socket;
  public connectInfo: IConnect;
  private handshakeDone: boolean;
  private handshakeResolve?: () => void;
  public handshake: Promise<void>;
  constructor(connect: IConnect) {
    this.connectInfo = connect;
    this.socket = net.connect({ host: connect.host, port: connect.port }, () => {
      new RecvStream(this.socket, 4, this.recv);
    });
    this.handshakeDone = false;
    this.handshake = new Promise(resolve => {
      this.handshakeResolve = resolve;
    });
  }

  private recv: IGetLengthFn = async (buffer, readBufferFn) => {
    const buf = new Buf(buffer);
    const len = buf.readUIntLE(3),
      index = buf.readUIntLE(1);
    if (!this.handshakeDone) {
      this.handshakeFn(await RecvAll(readBufferFn(len)), index);
    }
  };
  private send(buf: Buffer, index: number) {
    const head = Buffer.alloc(4);
    head.writeIntLE(buf.length, 0, 3);
    head[3] = index;
    this.socket.write(Buffer.concat([head, buf]));
  }
  private handshakeFn(buffer: Buffer, index: number) {
    const handshakeBuf = new Buf(buffer);
    if (index === 0) {
      const info = {
        protocol_version: handshakeBuf.readUIntLE(1),
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

      //loginBuf.alloc(23, 0);
      loginBuf.write(Buffer.alloc(23));
      //;
      loginBuf.writeStringNUL(this.connectInfo.user);
      const password_sha1 = SHA1(Buffer.from(this.connectInfo.password));
      const password = Buffer.alloc(password_sha1.length);
      SHA1(Buffer.concat([info.auth_plugin_data_part_1, info.auth_plugin_data_part_2, SHA1(password_sha1)])).forEach((byte, i) => {
        password[i] = byte ^ password_sha1[i];
      });
      //console.log(password, loginBuf.buffer);
      loginBuf.writeUIntLE(password.length, 1);
      loginBuf.write(password);
      loginBuf.writeStringNUL(this.connectInfo.database);
      loginBuf.writeStringNUL(info.auth_plugin_name);
      loginBuf.offset = 0;
      const info2 = {
        capability_flags: loginBuf.read(4),
        max_packet_size: loginBuf.readUIntLE(4),
        character_set: loginBuf.readUIntLE(1) === 33 ? "utf8_general_ci" : "unknow",
        username: loginBuf.readString(undefined, loginBuf.offset + 23),
        password: loginBuf.read(loginBuf.readUIntLE(1)),
        database: loginBuf.readString(),
        auth_plugin_name: loginBuf.readString(),
      };
      console.log(info2);
      this.send(loginBuf.buffer, index + 1);
    } else {
      console.log(buffer);
      this.handshakeResolve && this.handshakeResolve();
      this.handshakeDone = true;
    }
  }
}
