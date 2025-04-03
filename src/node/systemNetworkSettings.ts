/**
 * systemNetworkSettings.ts
 *
 * 这个文件实现了系统网络设置相关的功能，包括：
 * 1. HTTP代理设置的读取和修改
 * 2. DNS服务器设置
 * 3. 网络端口占用检测
 * 4. 进程名称查询
 * 5. 代理协议实现（Trojan、Socks5）
 * 6. 物理网卡信息获取
 */

import * as child_process from "child_process";
import * as os from "os";
import * as http from "http";
import * as net from "net";
import * as tls from "tls";
import * as crypto from "crypto";
import { afterExit } from "./afterExit";
import { Buf } from "./Buf";
import { RecvStream } from "./RecvStream";
import { childProcessExec } from "./utils";

/**
 * 获取MacOS所有network services
 *
 * 通过执行系统命令获取Mac OS系统中所有可用的网络服务
 * @returns 返回一个Promise，解析为网络服务名称的数组
 */
const getMacOSAllNetworkServices = async () =>
  (await childProcessExec("networksetup -listallnetworkservices"))
    .split("\n")
    .filter(line => line.trim() && !line.includes("*"));

/**
 * 操作系统HTTP代理状态枚举
 *
 * 使用二进制位表示不同的代理状态组合：
 *    x     x      x       1
 * 自动检测 PAC 代理服务器 固定位
 *
 * 最低位固定为1，其他位分别代表代理服务器、PAC脚本和自动检测的开启状态
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

/**
 * 操作系统HTTP代理配置选项接口
 *
 * 定义了设置系统代理时需要的各种参数
 */
export type IOperatingSystemHttpProxyOpt = {
  /** 代理设置的修改次数，用于Windows系统 */
  times?: number;
  /** 代理状态，使用EOperatingSystemHttpProxyStatus枚举值 */
  status: EOperatingSystemHttpProxyStatus;
  /** 代理服务器地址，格式为"IP:端口" */
  proxyIp?: string;
  /** 不使用代理的IP列表，多个IP用分号分隔 */
  noProxyIps?: string;
  /** PAC脚本URL */
  pac?: string;
  /** 网络服务名称，用于Mac OS系统 */
  networkService?: string;
};

/**
 * HTTP代理配置工厂类
 *
 * 用于创建和管理不同类型的HTTP代理配置（如WebProxy、SecureWebProxy等）
 * 主要用于Mac OS系统的代理设置
 */
class OperatingSystemHttpProxyOptFactory {
  /** 代理类型名称 */
  public readonly name: string;
  /** 代理类型对应的状态位标志 */
  public readonly flag: number;
  /** 代理启用状态的键名 */
  public readonly enabledKey: string = "Enabled";
  /** 代理启用状态的命令标志 */
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
/**
 * HTTP代理设置管理类
 *
 * 用于查看和设置系统的HTTP代理，支持Windows和Mac OS系统
 * 可以自动在程序退出时恢复原始代理设置
 */
export class OperatingSystemHttpProxy {
  /** 当前操作系统平台 */
  private OS = os.platform();

  /** Windows注册表路径，用于存储代理设置 */
  private readonly winRegPath = `"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections" /v DefaultConnectionSettings`;

  /** 是否在程序退出时自动恢复原始代理设置 */
  private autoReset = false;

  /** 程序退出时需要执行的命令，用于恢复原始代理设置 */
  private afterExitCmd: string = "";

  /**
   * 获取Windows代理设置的二进制数据
   *
   * 通过查询注册表获取Windows系统当前的代理设置
   * @returns 返回一个Promise，解析为包含代理设置的Buffer对象
   */
  private getWinProxyBuf(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      child_process.exec(`REG QUERY ${this.winRegPath}`, (err, data) => {
        if (!err && data) {
          resolve(
            Buffer.from(
              (String(data)
                .trim()
                .match(/REG_BINARY\s+([\dA-F]+)$/) || [])[1] || "",
              "hex",
            ),
          );
        } else {
          reject(err || new Error("no data"));
        }
      });
    });
  }

  /**
   * 设置Windows代理的二进制数据
   *
   * 通过修改注册表设置Windows系统的代理
   * @param buffer 包含代理设置的Buffer对象
   * @returns 返回一个Promise，解析为设置是否成功
   */
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

  /**
   * 解析Windows代理设置的二进制数据
   *
   * 将从注册表获取的二进制数据解析为代理配置对象
   * @param buffer 包含代理设置的Buffer对象
   * @returns 返回解析后的代理配置对象
   */
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

  /**
   * 将代理配置对象转换为Windows代理设置的二进制数据
   *
   * @param newOpt 代理配置对象
   * @returns 返回包含代理设置的Buffer对象
   */
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

  /**
   * Mac OS代理配置工厂类缓存
   *
   * 用于缓存不同类型的Mac OS代理配置工厂类实例
   */
  private static MacOSProxyFormatsCache: {
    [x: string]: OperatingSystemHttpProxyOptFactory;
  } | null;

  /**
   * 获取Mac OS代理配置工厂类
   *
   * 创建并返回不同类型的Mac OS代理配置工厂类实例
   * 包括自动代理URL、Web代理、安全Web代理、代理绕过域名和自动代理发现
   */
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

  /**
   * 获取Mac OS系统的代理设置
   *
   * 通过执行系统命令获取Mac OS系统当前的代理设置
   * @param networkServices 网络服务名称数组
   * @returns 返回一个Promise，解析为代理配置对象数组
   */
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
          }),
        );
        return opt;
      }),
    );
  }

  /**
   * 生成设置Mac OS代理的命令
   *
   * 根据代理配置对象生成设置Mac OS系统代理的命令
   * @param newOpts 代理配置对象数组
   * @returns 返回设置代理的命令字符串
   */
  private setMacOSProxyCommand(newOpts: IOperatingSystemHttpProxyOpt[]) {
    return newOpts
      .map(opt =>
        Object.values(OperatingSystemHttpProxy.MacOSProxyFormats)
          .map(a => a.set(opt))
          .filter(Boolean)
          .join(" & "),
      )
      .filter(Boolean)
      .join(" & ");
  }

  /**
   * 构造函数
   *
   * @param autoReset 是否在程序退出时自动恢复原始代理设置，默认为false
   */
  constructor(autoReset = false) {
    if (autoReset) {
      afterExit(() => {
        // console.log("afterExitCmd", this.afterExitCmd);
        if (this.afterExitCmd) child_process.execSync(this.afterExitCmd);
      });
    }
    this.autoReset = autoReset;
  }

  /**
   * 设置系统代理
   *
   * 根据提供的配置设置系统代理，支持Windows和Mac OS系统
   * 如果启用了autoReset，会在程序退出时自动恢复原始代理设置
   * @param newOpt 代理配置对象
   * @returns 返回this实例，支持链式调用
   */
  /** 设置代理，若networkService为空，则代表设置所有网卡 */
  public async set(newOpt: IOperatingSystemHttpProxyOpt) {
    switch (this.OS) {
      case "win32":
        if (this.autoReset && !this.afterExitCmd) {
          this.afterExitCmd = `REG add ${this.winRegPath} /f /t REG_BINARY /d "${(await this.getWinProxyBuf()).toString(
            "hex",
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

  /**
   * 获取系统代理设置
   *
   * 获取当前系统的代理设置，支持Windows和Mac OS系统
   * @param networkServices 网络服务名称数组，仅Mac OS系统有效
   * @returns 返回一个Promise，解析为代理配置对象数组
   */
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

  /**
   * 获取通过代理的Socket连接
   *
   * 根据系统代理设置创建一个通过代理连接到目标服务器的Socket
   * 如果没有设置代理或代理不可用，则直接连接到目标服务器
   * 不支持PAC脚本
   * @param host 目标服务器主机名
   * @param port 目标服务器端口
   * @param operatingSystemHttpProxyOpts 代理配置对象数组，如果不提供则使用系统当前的代理设置
   * @returns 返回一个Promise，解析为Socket对象
   */
  public async getHttpProxySocket(
    host: string,
    port: number,
    operatingSystemHttpProxyOpts?: Required<IOperatingSystemHttpProxyOpt>[],
  ) {
    const { proxyIp } =
      (operatingSystemHttpProxyOpts ?? (await this.get())).find(
        ({ proxyIp, status }) => (status & EOperatingSystemHttpProxyStatus.使用代理服务器) >> 1 && proxyIp,
      ) ?? {};

    if (!proxyIp) return net.connect({ host, port });
    return await new Promise<net.Socket>(r => {
      http
        .request({
          port: Number(proxyIp.split(":")[1] || "1080"),
          host: proxyIp.split(":")[0],
          method: "CONNECT",
          path: host + ":" + port,
        })
        .on("connect", (_, socket) => r(socket))
        .on("error", () => r(net.connect({ host, port })))
        .end();
    });
  }
}

/**
 * 测试用例：设置系统代理
 *
 * 创建一个带自动恢复功能的HTTP代理设置管理类实例，
 * 设置系统代理为127.0.0.1:1080，并使用PAC脚本
 */
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

/**
 * 设置系统DNS服务器
 *
 * 为系统所有网络接口设置DNS服务器，支持Windows和Mac OS系统
 * 可以在程序退出时自动恢复原始DNS设置
 *
 * @param addr DNS服务器地址，如"114.114.114.114"
 * @param autoReset 是否在程序退出时自动恢复原始DNS设置，默认为true
 * @returns 返回一个Promise，解析为设置了DNS的网络接口名称数组
 */
export const setDnsAddr = async (addr: string, autoReset = true) => {
  switch (os.platform()) {
    case "win32":
      // 获取所有非内部的IPv4网络接口
      const names = Object.entries(os.networkInterfaces())
        .map(([name, infos]) => {
          if (infos?.find(({ internal, family }) => !internal && family === "IPv4")) {
            return name;
          }
          return false;
        })
        .filter(a => a);

      // 如果启用了自动恢复，注册退出时的恢复命令
      if (autoReset) {
        afterExit(() => {
          child_process.execSync(
            names.map(name => `netsh interface ipv4 set dns name="${name}" source = dhcp`).join(" & ") +
              "& ipconfig/flushdns & netsh winsock reset",
          );
        });
      }

      // 为每个网络接口设置DNS服务器
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
                },
              ),
            ),
        ),
      );
      return names;
    /** Mac OS */
    case "darwin":
      // 获取所有网络服务
      const networkServices = await getMacOSAllNetworkServices();

      // 为每个网络服务设置DNS服务器
      await Promise.all(
        networkServices.map(async networkService => {
          try {
            await childProcessExec(`networksetup -setdnsservers "${networkService}" ${addr}`);
          } catch (e) {
            console.log("自动配置DNS\t\x1B[31m失败\x1B[0m\t", networkService, String(e));
          }
        }),
      );

      // 刷新DNS缓存
      await childProcessExec("dscacheutil -flushcache");

      // 如果启用了自动恢复，注册退出时的恢复命令
      if (autoReset) {
        afterExit(() => {
          child_process.execSync(
            networkServices.map(networkService => `networksetup -setdnsservers "${networkService}" empty`).join(" & ") +
              "& dscacheutil -flushcache",
          );
        });
      }
      return networkServices;
    default:
      throw new Error("You OS is not supported 'setDnsAddr'");
  }
};

/**
 * 测试用例：设置DNS服务器
 */
// setDnsAddr("114.114.114.114");
// setTimeout(() => {}, 1000000);

/**
 * 获取占用指定端口的进程ID列表
 *
 * 通过执行系统命令查询占用指定端口的进程ID
 * 支持Windows和Linux/Mac OS系统
 *
 * @param port 要查询的端口号
 * @param host 要查询的主机地址，默认为"0.0.0.0"（所有地址）
 * @param protocol 要查询的协议，可以是"TCP"或"UDP"，默认为"TCP"
 * @returns 返回一个Promise，解析为占用指定端口的进程ID数组
 */
export const getOccupiedNetworkPortPids = (
  port: number,
  host: string = "0.0.0.0",
  protocol: "TCP" | "UDP" = "TCP",
): Promise<number[]> => {
  // 根据操作系统构建不同的命令
  const cmd =
    os.platform() === "win32"
      ? `netstat -aon -p ${protocol}|findstr "${host}:${port}"`
      : `lsof -nP -i :${port}${protocol === "TCP" ? "|grep LISTEN" : ""}`;

  return new Promise((resolve, reject) =>
    child_process.exec(cmd, (err, stdout) => {
      // 构建正则表达式用于匹配结果
      const regs = [
        /** 判断ip和端口 */
        new RegExp(`\\s${host === "0.0.0.0" ? "(\\*|0.0.0.0)" : host}:${port}\\s`),
        /** 判断协议 */
        new RegExp(`\\s${protocol}\\s`, "i"),
        /** 判断状态 */
        protocol === "TCP" ? /\s(LISTENING|\(LISTEN\))\s/ : /\s/,
      ];
      // console.log(cmd, String(stdout || ""));

      // 解析命令输出，提取进程ID
      const pidInfo = String(stdout || "")
        .trim()
        .split("\n")
        .filter(line => regs.every(reg => reg.test(` ${line} `)))
        .map(line => Number((line + " ").match(/\s(\d+)\s/)?.[1] || 0))
        .filter(Boolean);
      resolve(pidInfo);
    }),
  );
};

/**
 * 测试用例：获取占用端口的进程ID
 */
// getOccupiedNetworkPortPids(80,"127.0.0.1","TCP")

/**
 * 通过通信端口获取应用名称
 *
 * 根据远程端口和本地端口查询对应的进程名称
 * 支持Windows和Linux/Mac OS系统
 *
 * @param remotePort 远程端口号，默认为0
 * @param localPort 本地端口号，默认为0
 * @returns 返回一个Promise，解析为应用程序名称，如果未找到则返回空字符串
 */
export const getProcessNameByPort = (remotePort: number = 0, localPort: number = 0) =>
  new Promise(resolve =>
    os.platform() === "win32"
      ? child_process.exec(`netstat -aonp TCP |findstr ":${remotePort}"`, (err, data) => {
          if (err) {
            resolve("");
            return;
          }
          // 从netstat输出中提取进程ID
          const pid = (String(data).match(
            new RegExp(
              `TCP\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${remotePort}\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${localPort}\\s+\\S+\\s+(\\d+)`,
            ),
          ) || [])[1];
          if (!pid) {
            resolve("");
            return;
          }
          // 根据进程ID查询进程名称
          child_process.exec(`tasklist /FI "PID eq ${pid}" /NH`, (err, data) =>
            resolve(
              (
                (!err &&
                  (String(data)
                    .trim()
                    .match(new RegExp(`^(.+?)\\s+${pid}`)) || [])[1]) ||
                ""
              ).trim(),
            ),
          );
        })
      : child_process.exec(`lsof -nP -i :${localPort}|grep ":${remotePort}->"`, (err, data) =>
          resolve(String(data || "").split(/\s/)[0] || ""),
        ),
  );

/**
 * 创建Trojan代理Socket连接
 *
 * 使用Trojan代理协议创建一个Socket连接，可用于访问被封锁的网站
 *
 * @param trojanTarget Trojan代理服务器地址，可以是Base64编码的订阅内容或trojan开头的URL
 * @param outsideHost 目标服务器主机名
 * @param outsidePort 目标服务器端口
 * @returns 返回一个Promise，解析为通过Trojan代理连接到目标服务器的Socket
 */
export const createTrojanSocket: (
  /** 传入由Trojan的"订阅内容"或trojan开头的URL */
  trojanTarget: string,
  outsideHost: string,
  outsidePort: number,
) => Promise<net.Socket> = (trojanTarget, outsideHost, outsidePort) =>
  new Promise((resolve, reject) => {
    // 检查并转换Trojan URL格式
    const reg = /^trojan\:/;
    if (!reg.test(trojanTarget)) {
      trojanTarget = String(Buffer.from(trojanTarget, "base64"));
    }
    if (!reg.test(trojanTarget)) {
      reject(new Error("转换协议失败"));
      return;
    }

    // 解析Trojan URL
    const { hostname, port, searchParams, username } = new URL(trojanTarget.replace(reg, "http:"));

    // 创建TLS连接到Trojan服务器
    const sock = tls.connect({
      host: hostname,
      port: Number(port),
      // rejectUnauthorized: false,
      servername: searchParams.get("sni") || undefined,
    });

    // 构建Trojan协议数据包
    const buf = new Buf();
    // 写入密码的SHA224哈希值
    buf.writeStringPrefix(crypto.createHash("sha224").update(username).digest("hex"), () => {
      return undefined;
    });
    // 写入CRLF和命令（0x01表示CONNECT，0x03表示域名类型）
    buf.write(Buffer.from([0x0d, 0x0a, 1, 3]));
    // 写入目标主机名（带长度前缀）
    buf.writeStringPrefix(outsideHost, len => {
      buf.writeUIntBE(len, 1);
      return undefined;
    });
    // 写入目标端口
    buf.writeUIntBE(outsidePort, 2);
    // 写入CRLF
    buf.write(Buffer.from([0x0d, 0x0a]));
    // 发送数据包
    sock.write(buf.buffer);
    resolve(sock);
  });

/**
 * 网络接口信息类型
 *
 * 扩展了Node.js的NetworkInterfaceInfo类型，添加了网络接口名称
 */
export type IGetPhysicalNetworkInterfaces = os.NetworkInterfaceInfo & { name: string };

/**
 * 获取物理网卡（出口网卡）的地址
 *
 * 通过尝试连接到指定主机，确定系统使用的出口网卡信息
 *
 * @param host 用于测试连接的主机名，默认为"www.baidu.com"
 * @param port 用于测试连接的端口，默认为80
 * @returns 返回一个Promise，解析为物理网卡信息数组
 */
export const getPhysicalNetworkInterfaces = (
  host = "www.baidu.com",
  port = 80,
): Promise<IGetPhysicalNetworkInterfaces[]> =>
  new Promise((resolve, reject) => {
    // 创建到目标主机的连接
    const sock = net.connect({ host, port });
    sock.once("connect", () => {
      // 获取本地IP地址
      const { localAddress } = sock;
      // 获取所有网络接口信息并添加名称属性
      const allNetworkInterfaces = Object.entries(os.networkInterfaces())
        .map(([name, networkInterfaces]) =>
          (networkInterfaces || []).map(networkInterface => ({ name, ...networkInterface })),
        )
        .flat();

      if (localAddress) {
        // 找到与本地IP地址匹配的网络接口
        const physicalName = new Set(
          allNetworkInterfaces.filter(({ address }) => address === localAddress).map(({ name }) => name),
        );
        resolve(allNetworkInterfaces.filter(({ name }) => physicalName.has(name)));
      }
      sock.destroy();
    });
    sock.on("error", reject);
  });

/**
 * 测试用例：使用Trojan代理访问Google
 */
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

/**
 * 创建SOCKS5代理Socket连接
 *
 * 使用SOCKS5协议创建一个Socket连接，可用于访问被封锁的网站
 *
 * @param target 目标服务器信息，包含host和port，默认为{ host: "www.google.com", port: 80 }
 * @param proxy SOCKS5代理服务器信息，包含host和port，默认为{ host: "127.0.0.1", port: 10808 }
 * @returns 返回一个Promise，解析为通过SOCKS5代理连接到目标服务器的Socket
 */
export const socks5 = async (
  target = { host: "www.google.com", port: 80 },
  proxy = { host: "127.0.0.1", port: 10808 },
) => {
  // 连接到SOCKS5代理服务器
  const sock = net.connect({ host: proxy.host, port: proxy.port });

  /** （一）客户端发送的报头 */
  // 发送SOCKS5握手请求，表示支持无认证方式
  sock.write(Buffer.from([0x05, 1, 0]));

  /** （二）代理服务器响应的报头 */
  // 接收代理服务器的握手响应
  const recvStream = new RecvStream(sock);
  const [VER, METHOD] = (await recvStream.readBufferSync(2)) || [];
  // 检查代理服务器是否接受无认证连接
  if (METHOD === 0xff) throw new Error(proxy.host + ":" + proxy.port + "代理服务器拒绝访问");
  if (METHOD) throw new Error(proxy.host + ":" + proxy.port + "代理服务器需要提供账号密码");

  /** （三）客户端发送需要访问的IP和端口，以及协议 */
  const buf = new Buf();
  buf.writeIntLE(5, 1); // VER 版本号，socks5的值为0x05
  buf.writeIntLE(0x01, 1); // 0x01表示CONNECT请求 0x02表示BIND请求 0x03表示UDP转发
  buf.writeIntLE(0, 1); // RSV 保留字段，值为0x00

  // 根据目标地址类型选择不同的处理方式
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
  const [VERSION, RESPONSE, RSV, ADDRESS_TYPE, ip1, ip2, ip3, ip4, port1, port2] =
    (await recvStream.readBufferSync(10)) || [];

  // 检查代理服务器响应状态
  if (RESPONSE) {
    throw new Error(proxy.host + ":" + proxy.port + "代理服务器错误，错误码:" + RESPONSE);
    /**
     * SOCKS5错误码说明：
     * 0x00：代理服务器连接目标服务器成功
     * 0x01：代理服务器故障
     * 0x02：代理服务器规则集不允许连接
     * 0x03：网络无法访问
     * 0x04：目标服务器无法访问（主机名无效）
     * 0x05：连接目标服务器被拒绝
     * 0x06：TTL已过期
     * 0x07：不支持的命令
     * 0x08：不支持的目标服务器地址类型
     * 0x09 - 0xFF：未分配
     */
  }
  if (ADDRESS_TYPE === 0x04) throw new Error("暂不支持IPv6");

  // 连接成功，返回Socket
  // console.log({
  //   VERSION,
  //   RESPONSE,
  //   ADDRESS_TYPE,
  //   ADDR: `${ip1}.${ip2}.${ip3}.${ip4}`,
  //   PORT: port1 * 256 + port2,
  // });
  return sock;
};

/**
 * 测试用例：使用SOCKS5代理访问Google
 */
// socks5().then(socks => {
//   socks.write(`GET / HTTP/1.1\r\nHost: www.google.com\r\n\r\n`);
//   socks.pipe(process.stdout);
// });
