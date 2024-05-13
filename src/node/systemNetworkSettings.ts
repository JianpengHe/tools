import * as child_process from "child_process";
import * as os from "os";
import * as net from "net";
import * as tls from "tls";
import * as crypto from "crypto";
import { afterExit } from "./afterExit";
import { Buf } from "./Buf";
import { RecvStream } from "./RecvStream";
import { childProcessExec } from "./utils";

/** 获取MacOS所有network services */
const getMacOSAllNetworkServices = async () =>
  (await childProcessExec("networksetup -listallnetworkservices"))
    .split("\n")
    .filter(line => line.trim() && !line.includes("*"));
/**
 *    x     x      x       1
 * 自动检测 PAC 代理服务器 固定位
 */
export enum EOperatingSystemHttpProxyStatus {
  "全部禁用" = 0b0001,
  "全部开启" = 0b1111,
  "使用代理服务器" = 0b0011,
  "使用自动脚本" = 0b0101,
  "使用脚本和代理" = 0b0111,
  "打开自动检测设置" = 0b1001,
  "打开自动检测并使用代理" = 0b1011,
  "打开自动检测并使用脚本" = 0b1101,
}
export type IOperatingSystemHttpProxyOpt = {
  times?: number;
  status: EOperatingSystemHttpProxyStatus;
  proxyIp?: string;
  noProxyIps?: string;
  pac?: string;
  networkService?: string;
};

/** 工厂函数 */
class OperatingSystemHttpProxyOptFactory {
  public readonly name: string;
  public readonly flag: number;
  public readonly enabledKey: string = "Enabled";
  public readonly enabledFlag: string;
  private doGet: (opt: IOperatingSystemHttpProxyOpt, obj: { [x: string]: string }) => void;
  public get(opt: IOperatingSystemHttpProxyOpt, raw: string): void {
    const obj = OperatingSystemHttpProxyOptFactory.MacOSProxyRawToObj(raw);
    // console.log(this.name, obj);
    if (this.enabledKey) {
      if (obj[this.enabledKey] === "On") {
        opt.status |= this.flag;
      } else {
        opt.status ^= this.flag;
      }
    }
    return this.doGet(opt, obj);
  }
  private doSet: OperatingSystemHttpProxyOptFactory["set"];

  public set(opt: IOperatingSystemHttpProxyOpt): string {
    const output: string[] = [];
    const setCMD = this.doSet(opt);

    /** 内容是否对上 */
    if (setCMD) output.push(`networksetup -set${this.name} "${opt.networkService}" ${setCMD}`);

    /** 开关状态是否对上 */
    // if (this.isEnabled(opt) !== this.isEnabled(oldOpt))
    this.enabledFlag &&
      output.push(`networksetup -set${this.enabledFlag} "${opt.networkService}" ${this.isEnabled(opt) ? "on" : "off"}`);

    return output.join(" & ");
  }
  public isEnabled(opt: IOperatingSystemHttpProxyOpt) {
    return this.flag === 0 ? true : Boolean(opt.status & this.flag);
  }

  constructor(opt: {
    name: string;
    flag: number;
    enabledKey?: string;
    get: OperatingSystemHttpProxyOptFactory["doGet"];
    set: OperatingSystemHttpProxyOptFactory["doSet"];
    enabledFlag: string;
  }) {
    this.name = opt.name;
    this.flag = opt.flag;
    this.enabledKey = opt.enabledKey ?? this.enabledKey;
    this.doGet = opt.get;
    this.doSet = opt.set;
    this.enabledFlag = opt.enabledFlag;
  }
  private static MacOSProxyRawToObj(raw: string) {
    const obj: { [x: string]: string } = {};
    for (const line of raw.trim().split("\n")) {
      const index = line.indexOf(":");
      if (index < 0) {
        obj[line.trim()] = "";
        continue;
      }
      obj[line.substring(0, index).trim()] = line.substring(index + 1).trim();
    }
    return obj;
  }
}
/** 查看/设置HTTP代理 */
export class OperatingSystemHttpProxy {
  private OS = os.platform();
  private readonly winRegPath = `"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections" /v DefaultConnectionSettings`;

  private autoReset = false;
  private afterExitCmd: string = "";

  private getWinProxyBuf(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      child_process.exec(`REG QUERY ${this.winRegPath}`, (err, data) => {
        if (!err && data) {
          resolve(
            Buffer.from(
              (String(data)
                .trim()
                .match(/REG_BINARY\s+([\dA-F]+)$/) || [])[1] || "",
              "hex"
            )
          );
        } else {
          reject(err || new Error("no data"));
        }
      });
    });
  }

  private setWinProxyBuf(buffer: Buffer): Promise<boolean> {
    return new Promise((resolve, reject) => {
      child_process.exec(`REG add ${this.winRegPath} /f /t REG_BINARY /d "${buffer.toString("hex")}"`, (err, data) => {
        if (err || !data) {
          reject(err || new Error("no data"));
        } else {
          resolve(true);
        }
      });
    });
  }

  private parseWin(buffer: Buffer) {
    const buf = new Buf(buffer);
    if (buf.readUIntLE(4) !== 0x46) {
      throw new Error("解析失败");
    }
    const out: Required<IOperatingSystemHttpProxyOpt> = {
      times: buf.readUIntLE(4),
      status: buf.readUIntLE(4),
      proxyIp: buf.readString(buf.readUIntLE(4)),
      noProxyIps: buf.readString(buf.readUIntLE(4)),
      pac: buf.readString(buf.readUIntLE(4)),
      networkService: "",
    };
    return out;
  }

  private stringifyWin(newOpt: IOperatingSystemHttpProxyOpt) {
    const buf = new Buf();
    buf.writeUIntLE(0x46, 4);
    buf.writeUIntLE(newOpt.times ?? 0, 4);
    buf.writeUIntLE(Number(newOpt?.status), 4);
    buf.writeStringPrefix(newOpt.proxyIp ?? "127.0.0.1:1080", len => {
      buf.writeUIntLE(len, 4);
      return undefined;
    });
    buf.writeStringPrefix(newOpt.noProxyIps ?? "127.0.0.1;<local>", len => {
      buf.writeUIntLE(len, 4);
      return undefined;
    });
    buf.writeStringPrefix(newOpt.pac ?? "", len => {
      buf.writeUIntLE(len, 4);
      return undefined;
    });
    buf.write(Buffer.alloc(32));
    return buf.buffer;
  }
  private static MacOSProxyFormatsCache: {
    [x: string]: OperatingSystemHttpProxyOptFactory;
  } | null;
  private static get MacOSProxyFormats() {
    return (
      OperatingSystemHttpProxy.MacOSProxyFormatsCache ||
      (OperatingSystemHttpProxy.MacOSProxyFormatsCache = {
        autoproxyurl: new OperatingSystemHttpProxyOptFactory({
          name: "autoproxyurl",
          enabledFlag: "autoproxystate",
          flag: 0b0100,
          get(opt, { URL }) {
            opt.pac = URL === "(null)" ? "" : URL;
          },
          set(opt) {
            return opt.pac === undefined ? "" : `"${opt.pac || ""}"`;
          },
        }),

        webproxy: new OperatingSystemHttpProxyOptFactory({
          name: "webproxy",
          flag: 0b0010,
          enabledFlag: `webproxystate`,
          get(opt, { Server, Port }) {
            opt.proxyIp = Server && Number(Port) ? Server + ":" + Port : "";
          },
          set(opt) {
            return opt.proxyIp === undefined ? "" : (opt.proxyIp || "").replace(":", " ");
          },
        }),
        securewebproxy: new OperatingSystemHttpProxyOptFactory({
          name: "securewebproxy",
          enabledFlag: "securewebproxystate",
          flag: 0b0010,
          get(opt, { Server, Port }) {
            opt.proxyIp = Server && Number(Port) ? Server + ":" + Port : "";
          },
          set(opt) {
            return opt.proxyIp === undefined ? "" : (opt.proxyIp || "").replace(":", " ");
          },
        }),
        proxybypassdomains: new OperatingSystemHttpProxyOptFactory({
          name: "proxybypassdomains",
          enabledFlag: "",
          flag: 0,
          enabledKey: "",
          get(opt, obj) {
            opt.noProxyIps = Object.keys(obj).join(";");
          },
          set(opt) {
            return opt.noProxyIps === undefined
              ? ""
              : (opt.noProxyIps || "")
                  .split(";")
                  .map(host => `"${host}"`)
                  .join(" ");
          },
        }),
        proxyautodiscovery: new OperatingSystemHttpProxyOptFactory({
          name: "proxyautodiscovery",
          enabledFlag: "proxyautodiscovery",
          flag: 0b1000,
          enabledKey: "Auto Proxy Discovery",
          get(opt, obj) {},
          set(opt) {
            return "";
          },
        }),
      })
    );
  }
  private getMacOSProxy(networkServices: string[]) {
    return Promise.all(
      networkServices.map(async networkService => {
        const opt: Required<IOperatingSystemHttpProxyOpt> = {
          times: 0,
          status: EOperatingSystemHttpProxyStatus.全部禁用,
          proxyIp: "",
          noProxyIps: "",
          pac: "",
          networkService,
        };

        await Promise.all(
          Object.values(OperatingSystemHttpProxy.MacOSProxyFormats).map(async a => {
            a.get(opt, await childProcessExec(`networksetup -get${a.name} "${networkService}"`));
          })
        );
        return opt;
      })
    );
  }
  private setMacOSProxyCommand(newOpts: IOperatingSystemHttpProxyOpt[]) {
    return newOpts
      .map(opt =>
        Object.values(OperatingSystemHttpProxy.MacOSProxyFormats)
          .map(a => a.set(opt))
          .filter(Boolean)
          .join(" & ")
      )
      .filter(Boolean)
      .join(" & ");
  }
  constructor(autoReset = false) {
    if (autoReset) {
      afterExit(() => {
        // console.log("afterExitCmd", this.afterExitCmd);
        if (this.afterExitCmd) child_process.execSync(this.afterExitCmd);
      });
    }
    this.autoReset = autoReset;
  }

  /** 设置代理，若networkService为空，则代表设置所有网卡 */
  public async set(newOpt: IOperatingSystemHttpProxyOpt) {
    switch (this.OS) {
      case "win32":
        if (this.autoReset && !this.afterExitCmd) {
          this.afterExitCmd = `REG add ${this.winRegPath} /f /t REG_BINARY /d "${(await this.getWinProxyBuf()).toString(
            "hex"
          )}"`;
        }
        await this.setWinProxyBuf(this.stringifyWin(newOpt));
        break;
      case "darwin":
        if (this.autoReset && !this.afterExitCmd) {
          this.afterExitCmd = this.setMacOSProxyCommand(await this.get());
        }
        const opts: IOperatingSystemHttpProxyOpt[] = [];
        if (newOpt.networkService) {
          opts.push(newOpt);
        } else {
          (await getMacOSAllNetworkServices()).forEach(networkService => opts.push({ ...newOpt, networkService }));
        }

        const cmd = this.setMacOSProxyCommand(opts);
        // console.log("set", cmd);
        cmd && (await childProcessExec(cmd));
        break;
      default:
        throw new Error("You OS is not supported 'OperatingSystemHttpProxy'");
    }

    return this;
  }
  /** 获取所有网卡的代理设置 */
  public async get(networkServices?: string[]) {
    switch (this.OS) {
      case "win32":
        return [this.parseWin(await this.getWinProxyBuf())];
      case "darwin":
        return await this.getMacOSProxy(networkServices ?? (await getMacOSAllNetworkServices()));
      default:
        throw new Error("You OS is not supported 'OperatingSystemHttpProxy'");
    }
  }
}

// (async () => {
//   const operatingSystemHttpProxy = new OperatingSystemHttpProxy(true);
//   // console.log(await operatingSystemHttpProxy.get());
//   await new Promise(r => setTimeout(r, 1000));
//   await operatingSystemHttpProxy.set({
//     proxyIp: "127.0.0.1:1080",
//     status: EOperatingSystemHttpProxyStatus.使用脚本和代理,
//     pac: "http://127.0.0.1:1080/pg_pac_script_config",
//   });
//   await new Promise(r => setTimeout(r, 30000));
// })();

/** 设置DNS服务器 */
export const setDnsAddr = async (addr: string, autoReset = true) => {
  switch (os.platform()) {
    case "win32":
      const names = Object.entries(os.networkInterfaces())
        .map(([name, infos]) => {
          if (infos?.find(({ internal, family }) => !internal && family === "IPv4")) {
            return name;
          }
          return false;
        })
        .filter(a => a);
      if (autoReset) {
        afterExit(() => {
          child_process.execSync(
            names.map(name => `netsh interface ipv4 set dns name="${name}" source = dhcp`).join(" & ") +
              "& ipconfig/flushdns & netsh winsock reset"
          );
        });
      }

      await Promise.all(
        names.map(
          name =>
            new Promise((resolve, reject) =>
              child_process.exec(
                `netsh interface ipv4 set dns name="${name}" source=static addr=${addr} register=PRIMARY && ipconfig/flushdns`,
                (err, out) => {
                  if (err) {
                    child_process.execFileSync("cmd", [`/C chcp 65001>nul`]);
                    console.log("自动配置DNS\t\x1B[31m" + out.trim() + "\x1B[0m\t", name);
                    reject(err);
                    return;
                  }
                  // console.log("自动配置DNS", name);
                  resolve(true);
                }
              )
            )
        )
      );
      return names;
    /** Mac OS */
    case "darwin":
      const networkServices = await getMacOSAllNetworkServices();

      await Promise.all(
        networkServices.map(async networkService => {
          try {
            await childProcessExec(`networksetup -setdnsservers "${networkService}" ${addr}`);
          } catch (e) {
            console.log("自动配置DNS\t\x1B[31m失败\x1B[0m\t", networkService, String(e));
          }
        })
      );
      await childProcessExec("dscacheutil -flushcache");
      if (autoReset) {
        afterExit(() => {
          child_process.execSync(
            networkServices.map(networkService => `networksetup -setdnsservers "${networkService}" empty`).join(" & ") +
              "& dscacheutil -flushcache"
          );
        });
      }
      return networkServices;
    default:
      throw new Error("You OS is not supported 'setDnsAddr'");
  }
};

// setDnsAddr("114.114.114.114");
// setTimeout(() => {}, 1000000);
/** 占用端口的应用pid */
export const getOccupiedNetworkPortPids = (
  port: number,
  host: string = "0.0.0.0",
  protocol: "TCP" | "UDP" = "TCP"
): Promise<number[]> => {
  const cmd =
    os.platform() === "win32"
      ? `netstat -aon -p ${protocol}|findstr "${host}:${port}"`
      : `lsof -nP -i :${port}${protocol === "TCP" ? "|grep LISTEN" : ""}`;
  return new Promise((resolve, reject) =>
    child_process.exec(cmd, (err, stdout) => {
      const regs = [
        /** 判断ip和端口 */
        new RegExp(`\\s${host === "0.0.0.0" ? "(\\*|0.0.0.0)" : host}:${port}\\s`),
        /** 判断协议 */
        new RegExp(`\\s${protocol}\\s`, "i"),
        /** 判断状态 */
        protocol === "TCP" ? /\s(LISTENING|\(LISTEN\))\s/ : /\s/,
      ];
      // console.log(cmd, String(stdout || ""));

      const pidInfo = String(stdout || "")
        .trim()
        .split("\n")
        .filter(line => regs.every(reg => reg.test(` ${line} `)))
        .map(line => Number((line + " ").match(/\s(\d+)\s/)?.[1] || 0))
        .filter(Boolean);
      resolve(pidInfo);
    })
  );
};

// getOccupiedNetworkPortPids(80,"127.0.0.1","TCP")

/** 通过通信端口，获取应用名称 */
export const getProcessNameByPort = (remotePort: number = 0, localPort: number = 0) =>
  new Promise(resolve =>
    os.platform() === "win32"
      ? child_process.exec(`netstat -aonp TCP |findstr ":${remotePort}"`, (err, data) => {
          if (err) {
            resolve("");
            return;
          }
          const pid = (String(data).match(
            new RegExp(
              `TCP\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${remotePort}\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${localPort}\\s+\\S+\\s+(\\d+)`
            )
          ) || [])[1];
          if (!pid) {
            resolve("");
            return;
          }
          child_process.exec(`tasklist /FI "PID eq ${pid}" /NH`, (err, data) =>
            resolve(
              (
                (!err &&
                  (String(data)
                    .trim()
                    .match(new RegExp(`^(.+?)\\s+${pid}`)) || [])[1]) ||
                ""
              ).trim()
            )
          );
        })
      : child_process.exec(`lsof -nP -i :${remotePort}|grep ":${localPort}->"`, (err, data) =>
          resolve(String(data || "").split(/\s/)[0] || "")
        )
  );

/** 使用Trojan代理协议 */
export const createTrojanSocket: (
  /** 传入由Trojan的“订阅内容”或trojan开头的URL */
  trojanTarget: string,
  outsideHost: string,
  outsidePort: number
) => Promise<net.Socket> = (trojanTarget, outsideHost, outsidePort) =>
  new Promise((resolve, reject) => {
    const reg = /^trojan\:/;
    if (!reg.test(trojanTarget)) {
      trojanTarget = String(Buffer.from(trojanTarget, "base64"));
    }
    if (!reg.test(trojanTarget)) {
      reject(new Error("转换协议失败"));
      return;
    }
    const { hostname, port, searchParams, username } = new URL(trojanTarget.replace(reg, "http:"));
    const sock = tls.connect({
      host: hostname,
      port: Number(port),
      // rejectUnauthorized: false,
      servername: searchParams.get("sni") || undefined,
    });
    const buf = new Buf();
    buf.writeStringPrefix(crypto.createHash("sha224").update(username).digest("hex"), () => {
      return undefined;
    });
    buf.write(Buffer.from([0x0d, 0x0a, 1, 3]));
    buf.writeStringPrefix(outsideHost, len => {
      buf.writeUIntBE(len, 1);
      return undefined;
    });
    buf.writeUIntBE(outsidePort, 2);
    buf.write(Buffer.from([0x0d, 0x0a]));
    sock.write(buf.buffer);
    resolve(sock);
  });

export type IGetPhysicalNetworkInterfaces = os.NetworkInterfaceInfo & { name: string };
/** 获取物理网卡（出口网卡）的地址 */
export const getPhysicalNetworkInterfaces = (
  host = "www.baidu.com",
  port = 80
): Promise<IGetPhysicalNetworkInterfaces[]> =>
  new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.once("connect", () => {
      const { localAddress } = sock;
      const allNetworkInterfaces = Object.entries(os.networkInterfaces())
        .map(([name, networkInterfaces]) =>
          (networkInterfaces || []).map(networkInterface => ({ name, ...networkInterface }))
        )
        .flat();
      if (localAddress) {
        const physicalName = new Set(
          allNetworkInterfaces.filter(({ address }) => address === localAddress).map(({ name }) => name)
        );
        resolve(allNetworkInterfaces.filter(({ name }) => physicalName.has(name)));
      }
      sock.destroy();
    });
    sock.on("error", reject);
  });

//测试用例
// const trojanTarget = "dHxxxxxx==";
// // const host = "2022.ip138.com";
// const host = "www.google.com";
// const port = 443;
// const req = require("https")
//   .request(
//     {
//       path: "/",
//       method: "get",
//       port,
//       host,
//       createConnection(_, oncreate) {
//         createTrojanSocket(trojanTarget, host, port).then(trojanSock => {
//           const httpsock = new tls.TLSSocket(trojanSock);
//           setTimeout(() => {
//             oncreate(null, httpsock);
//           }, 1000);
//         });
//       },
//     },
//     async res => {
//       const body: any = [];
//       for await (const chuck of res) {
//         body.push(chuck);
//       }
//       console.log(String(Buffer.concat(body)));
//     }
//   )
//   .end();

export const socks5 = async (
  target = { host: "www.google.com", port: 80 },
  proxy = { host: "127.0.0.1", port: 10808 }
) => {
  const sock = net.connect({ host: proxy.host, port: proxy.port });

  /** （一）客户端发送的报头 */
  sock.write(Buffer.from([0x05, 1, 0]));

  /** （二）代理服务器响应的报头 */
  const recvStream = new RecvStream(sock);
  const [VER, METHOD] = await recvStream.readBufferSync(2);
  if (METHOD === 0xff) throw new Error(proxy.host + ":" + proxy.port + "代理服务器拒绝访问");
  if (METHOD) throw new Error(proxy.host + ":" + proxy.port + "代理服务器需要提供账号密码");

  /** （三）客户端发送需要访问的IP和端口，以及协议 */
  const buf = new Buf();
  buf.writeIntLE(5, 1); // VER 版本号，socks5的值为0x05
  buf.writeIntLE(0x01, 1); // 0x01表示CONNECT请求 0x02表示BIND请求 0x03表示UDP转发
  buf.writeIntLE(0, 1); // RSV 保留字段，值为0x00
  switch (true) {
    /** 0x01表示IPv4地址，DST.ADDR为4个字节 **/
    case net.isIPv4(target.host):
      buf.writeIntLE(0x01, 1);
      buf.write(Buffer.from(target.host.split(".").map(a => Number(a))));
      break;

    /** 0x04表示IPv6地址，DST.ADDR为16个字节长度 **/
    case net.isIPv6(target.host):
      console.log(target);
      throw new Error("暂不支持IPv6");
      break;

    /** 0x03表示域名，DST.ADDR是一个可变长度的域名 **/
    default:
      buf.writeIntLE(0x03, 1);
      buf.writeStringPrefix(target.host, length => {
        buf.writeIntLE(length, 1);
        return undefined;
      });
  }
  buf.writeIntBE(target.port, 2); // DST.PORT 目标端口，固定2个字节
  sock.write(buf.buffer);

  /** （四）代理服务器响应 */
  const [VERSION, RESPONSE, RSV, ADDRESS_TYPE, ip1, ip2, ip3, ip4, port1, port2] = await recvStream.readBufferSync(10);
  if (RESPONSE) {
    throw new Error(proxy.host + ":" + proxy.port + "代理服务器错误，错误码:" + RESPONSE);
    /**
  0x00：代理服务器连接目标服务器成功
  0x01：代理服务器故障
  0x02：代理服务器规则集不允许连接
  0x03：网络无法访问
  0x04：目标服务器无法访问（主机名无效）
  0x05：连接目标服务器被拒绝
  0x06：TTL已过期
  0x07：不支持的命令
  0x08：不支持的目标服务器地址类型
  0x09 - 0xFF：未分配
     */
  }
  if (ADDRESS_TYPE === 0x04) throw new Error("暂不支持IPv6");
  // console.log({
  //   VERSION,
  //   RESPONSE,
  //   ADDRESS_TYPE,
  //   ADDR: `${ip1}.${ip2}.${ip3}.${ip4}`,
  //   PORT: port1 * 256 + port2,
  // });
  return sock;
};

/** 测试用例 */
// socks5().then(socks => {
//   socks.write(`GET / HTTP/1.1\r\nHost: www.google.com\r\n\r\n`);
//   socks.pipe(process.stdout);
// });
