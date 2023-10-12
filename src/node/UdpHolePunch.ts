import * as dgram from "dgram";

/** 利用UDP打洞P2P */
/** 服务器地址 */
const SERVER_IP = String(process.argv[2] || "").trim();
/** 服务器端口 */
const SERVER_PORT = 60008;
/**
 * 服务器端启动命令：node UdpHolePunch
 * 客户端启动命令：node UdpHolePunch xxx.xxx.xxx.xxx
 */

/** 如果不填服务器地址，则下面的脚本会以【服务器模式】运行 */
const IS_SERVER = !SERVER_IP;
console.log("IS_SERVER", IS_SERVER, SERVER_IP);
const sock = dgram.createSocket("udp4");

let waitSock: dgram.RemoteInfo | null;

const stringifyIpPort = (rinfo: dgram.RemoteInfo) => {
  const buf = Buffer.alloc(12);
  rinfo.address.split(".").forEach((n, i) => buf.writeUInt16LE(Number(n), i * 2));
  buf.writeUInt32LE(Number(rinfo.port), 8);
  return buf;
};

if (IS_SERVER) {
  sock.bind(SERVER_PORT);
  sock.on("listening", () => {
    const address = sock.address();
    console.log(`UDP server listening ${address.address}:${address.port}`);
  });
} else {
  sock.send(Buffer.alloc(0), SERVER_PORT, SERVER_IP);
}

sock.on("error", err => {
  console.log(`error:\n${err.stack}`);
  sock.close();
});

sock.on("message", (msg, rinfo) => {
  console.log(`server got msg from ${rinfo.address}:${rinfo.port}`);
  if (IS_SERVER) {
    if (waitSock) {
      sock.send(stringifyIpPort(rinfo), waitSock.port, waitSock.address);
      sock.send(stringifyIpPort(waitSock), rinfo.port, rinfo.address);
      waitSock = null;
      return;
    }
    waitSock = rinfo;
    return;
  }
  if (rinfo.port === SERVER_PORT && rinfo.address === SERVER_IP) {
    /** 来自公网服务器 */
    console.log(
      `需要连接到${msg.readUInt16LE(0)}.${msg.readUInt16LE(2)}.${msg.readUInt16LE(4)}.${msg.readUInt16LE(
        6
      )}:${msg.readUInt32LE(8)}`
    );
    setInterval(() => {
      sock.send(
        Buffer.from("hello"),
        msg.readUInt32LE(8),
        `${msg.readUInt16LE(0)}.${msg.readUInt16LE(2)}.${msg.readUInt16LE(4)}.${msg.readUInt16LE(6)}`
      );
    }, 1000);

    return;
  }
});
