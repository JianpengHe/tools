import * as net from "net";
import * as dns from "dns";
import * as fs from "fs";
import * as os from "os";
import { DnsServer } from "./dnsService";
import { afterExit } from "./afterExit";
import { childProcessExec } from "./utils";

const modifyHostsFile = (hostsFile: string[], host: string, ip: string) => {
  let oldIp = "";
  if (
    !hostsFile.some((line, i) => {
      const [_, ip2, host2] = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+(\S+)$/) || [];
      if (host === host2) {
        if (ip) {
          /** 如果ip不为空，则替换 */
          hostsFile.splice(i, 1, `${ip} ${host}`);
        } else {
          hostsFile.splice(i, 1);
        }
        oldIp = ip2;
        return true;
      }
      return false;
    })
  ) {
    hostsFile.push(`${ip} ${host}`);
  }
  return oldIp;
};

export type ITcpProxyAddOpt = {
  host: string;
  port: number;
  connectionListener: (socket: net.Socket) => void;
  /** 本地ip偏移；
   *  undefined：自动尝试绑定可用的ip；
   *  0：绑定【上一次成功绑定了】的ip，若无【上一次成功绑定了】则视为undefined；
   *  非0：强制使用该ip，如1代表127.0.0.1，如257代表127.0.1.2 ，绑定失败直接报错。
   * */
  localIPStartPos?: number;
};
export class TcpProxy {
  private readonly dnsMode: DnsServer | string;
  constructor(
    /** 接受DnsServer对象、host文件地址，不传默认new DnsServer */
    dnsMode?: DnsServer | string
  ) {
    this.dnsMode = (dnsMode ?? new DnsServer()) || "C:/Windows/System32/drivers/etc/hosts";
    if (!(this.dnsMode instanceof DnsServer)) {
      afterExit(() => {
        const hostsFile = String(fs.readFileSync(String(this.dnsMode))).split("\n");
        for (const [host, ip] of this.oldHostsFile) {
          modifyHostsFile(hostsFile, host, ip);
        }
        fs.writeFileSync(String(this.dnsMode), hostsFile.join("\n"));
      });
    }
  }
  public localIPtoString = (n: number) => `127.${Math.floor(n / 65536)}.${Math.floor(n / 256) % 256}.${n % 256}`;
  /** 最后绑定成功的 */
  private lastSuccessIP = 1;

  /** xx.xx.xx.xx 和 127.xx.xx.xx 的绑定关系 */
  public routeMap: Map<string, number> = new Map();

  /** 绑定了 xx.xx.xx.xx:xxxx 的 net.Server */
  public serverMap: Map<string, net.Server> = new Map();
  /** 绑定了 127.xx.xx.xx:xxxx 的 net.Server */
  public serverlocalIPMap: Map<string, net.Server> = new Map();

  /** 脚本运行前hosts文件的内容 key:host,value:ip */
  private oldHostsFile: Map<string, string> = new Map();

  private addQueue: Array<
    ITcpProxyAddOpt & { resolve: (netServer: net.Server) => void; reject: (reason?: any) => void }
  > = [];
  private createServerLock = false;
  private async tryToCreateServer(err = 0) {
    if (this.createServerLock || this.addQueue.length === 0) {
      return;
    }
    this.createServerLock = true;
    const { host, port, connectionListener, localIPStartPos, resolve, reject } = this.addQueue[0];
    try {
      const ip = net.isIPv4(host) ? host : (await dns.promises.resolve4(host))[0];
      const localIPNumber =
        (localIPStartPos || this.routeMap.get(ip) || this.lastSuccessIP + (localIPStartPos === 0 ? 0 : 1)) + err;
      const errFn = e => {
        console.log("TCP Proxy\t\x1B[31m重新绑定\x1B[0m\t");
        //console.log(e);
        this.createServerLock = false;
        if (localIPStartPos === undefined) {
          /** 尝试绑定下一个localIP */
          this.lastSuccessIP++;
        } else {
          this.addQueue.splice(0, 1);
          reject(new Error(e));
        }
        this.tryToCreateServer(err + 1);
      };
      const localIP = this.localIPtoString(localIPNumber);

      process.stdout.write(
        "TCP Proxy\t\x1B[33m正在尝试\x1B[0m\t" + port + "\t" + ip + "\t" + localIP + "\t" + host + "\r"
      );
      const multiplexServer =
        localIPStartPos === 0 ? this.serverlocalIPMap.get(localIP + ":" + port) : this.serverMap.get(ip + ":" + port);
      if (multiplexServer) {
        await new Promise(r => setTimeout(r, 10));
        if (multiplexServer.listeners("connection").includes(connectionListener)) {
          console.log("TCP Proxy\t\x1B[36m复用函数\x1B[0m\t");
        } else {
          console.log("TCP Proxy\t\x1B[36m复用服务\x1B[0m\t");
          multiplexServer.on("connection", connectionListener);
        }
        this.addDnsServer(ip, host, localIP);
        resolve(multiplexServer);
        // reject(new Error("已经绑定过了"));
        this.createServerLock = false;
        this.addQueue.splice(0, 1);
        this.tryToCreateServer();
        return;
      }
      if (os.platform() !== "win32" && localIP !== "127.0.0.1") {
        await childProcessExec(`ifconfig lo0 alias ${localIP} netmask 0xFFFFFFFF`);
      }
      const netServer = net.createServer();
      netServer.on("connection", connectionListener);
      netServer.once("error", errFn);
      netServer.listen(port, localIP, () => {
        console.log("TCP Proxy\t\x1B[32m新建成功\x1B[0m\t");
        netServer.removeListener("error", errFn);
        this.serverMap.set(ip + ":" + port, netServer);
        this.serverlocalIPMap.set(localIP + ":" + port, netServer);
        this.routeMap.set(ip, localIPNumber);
        this.addDnsServer(ip, host, localIP);
        resolve(netServer);
        this.createServerLock = false;
        this.addQueue.splice(0, 1);
        this.tryToCreateServer();
      });
    } catch (e) {
      reject(e);
    }
  }
  private addDnsServer(ip: string, host: string, localIP: string) {
    if (ip === host) {
      /** 已经是ip，无需解析 */
      return;
    } else if (this.dnsMode instanceof DnsServer) {
      this.dnsMode.add(localIP, host);
      return;
    }
    const hostsFile = String(fs.readFileSync(this.dnsMode)).split("\n");
    this.oldHostsFile.set(host, modifyHostsFile(hostsFile, host, localIP));
    fs.writeFileSync(this.dnsMode, hostsFile.join("\n"));
  }

  public add(opt: ITcpProxyAddOpt): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      this.addQueue.push({ ...opt, resolve, reject });
      this.tryToCreateServer();
    });
  }
}

// 测试用例
// const connectionListener = sock => {
//   console.log("con");
// };
// const tcpProxy = new TcpProxy();
// Promise.all([
//   tcpProxy.add({
//     host: "usa.gov",
//     port: 443,
//     connectionListener,
//     localIPStartPos: 0,
//   }),
//   tcpProxy.add({
//     host: "www.baidu.com",
//     port: 443,
//     connectionListener,
//     localIPStartPos: 0,
//   }),
//   tcpProxy.add({
//     host: "23.22.13.113",
//     port: 443,
//     connectionListener: a => {},
//     localIPStartPos: 0,
//   }),
//   tcpProxy.add({
//     host: "usa.gov",
//     port: 80,
//     connectionListener,
//     localIPStartPos: 0,
//   }),
// ]).then(([a, b, c]) => {
//   console.log([...tcpProxy.serverMap.keys()], tcpProxy.routeMap);
// });

// 使用例子
// import { createTrojanSocket } from "./systemNetworkSettings";
// import * as os from "os";
// const host = "www.google.com";
// const port = 443;
// const tcpProxy = new TcpProxy("");
// tcpProxy.add({
//   host,
//   port,
//   connectionListener: sock => {
//     createTrojanSocket(
//       String(fs.readFileSync(os.homedir() + "/Desktop/script/trojanTarget.txt")).trim(),
//       host,
//       port
//     ).then(sock2 => {
//       sock.pipe(sock2);
//       sock2.pipe(sock);
//     });
//   },
// });

// 使用例子2
// import { socks5 } from "./systemNetworkSettings";

// const port = 443;
// const tcpProxy = new TcpProxy(new DnsServer());
// tcpProxy.add({
//   host: "pub.dev",
//   port,
//   connectionListener: sock =>
//     socks5({ host: "pub.dev", port }).then(sock2 => {
//       console.log("代理", "pub.dev", port);
//       sock.pipe(sock2);
//       sock2.pipe(sock);
//       sock.on("error", e => console.log(e));
//       sock2.on("error", e => console.log(e));
//     }),
// });
// tcpProxy.add({
//   host: "maven.google.com",
//   port,
//   connectionListener: sock =>
//     socks5({ host: "maven.google.com", port }).then(sock2 => {
//       console.log("代理", "maven.google.com", port);
//       sock.pipe(sock2);
//       sock2.pipe(sock);
//       sock.on("error", e => console.log(e));
//       sock2.on("error", e => console.log(e));
//     }),
// });
