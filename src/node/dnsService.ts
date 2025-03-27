/**
 * DNS服务模块
 * 实现了DNS协议的解析和序列化，以及DNS服务器功能
 * 可用于自定义DNS解析、DNS代理、域名劫持等场景
 *
 * DNS协议是一种用于将域名转换为IP地址的网络协议
 * 参考资料：https://zh.wikipedia.org/wiki/DNS
 */
import * as dns from "dns";
import * as dgram from "dgram";
import * as net from "net";
import * as os from "os";
import * as child_process from "child_process";
import { Buf } from "./Buf";
import { getOccupiedNetworkPortPids, setDnsAddr } from "./systemNetworkSettings";

/**
 * DNS记录类型枚举
 * 详细介绍：https://zh.wikipedia.org/wiki/DNS%E8%AE%B0%E5%BD%95%E7%B1%BB%E5%9E%8B%E5%88%97%E8%A1%A8
 */
export enum EDnsResolveType {
  /** IPv4地址记录 */
  "A" = 1,
  /** 名称服务器记录 */
  "NS" = 2,
  /** 规范名称记录 */
  "CNAME" = 5,
  /** 权威记录的起始 */
  "SOA" = 6,
  /** 指针记录 */
  "PTR" = 12,
  /** 电邮交互记录 */
  "MX" = 15,
  /** 文本记录 */
  "TXT" = 16,
  /** 负责人 */
  "RP" = 17,
  /** AFS文件系统 */
  "AFSDB" = 18,
  /** 证书 */
  "SIG" = 24,
  /** 密钥记录 */
  "KEY" = 25,
  /** IPv6地址记录 */
  "AAAA" = 28,
  /** 位置记录 */
  "LOC" = 29,
  /** 服务定位器 */
  "SRV" = 33,
  /** 命名管理指针 */
  "NAPTR" = 35,
  /** 证书记录 */
  "CERT" = 37,
  /** 代表名称 */
  "DNAME" = 39,
  /** 地址前缀列表 */
  "APL" = 42,
  /** 委托签发者 */
  "DS" = 43,
  /** SSH 公共密钥指纹 */
  "SSHFP" = 44,
  /** IPSEC 密钥 */
  "IPSECKEY" = 45,
  /** DNSSEC 证书 */
  "RRSIG" = 46,
  /** 下一个安全记录 */
  "NSEC" = 47,
  /** DNSSEC所用公钥记录 */
  "DNSKEY" = 48,
  /** DHCP（动态主机设置协议）标识符 */
  "DHCID" = 49,
  /** 下一个安全记录第三版 */
  "NSEC3" = 50,
  /** NSEC3 参数 */
  "NSEC3PARAM" = 51,
  /** 主机鉴定协议 */
  "HIP" = 55,
  /** 子委托签发者 */
  "CDS" = 59,
  /** 子关键记录 */
  "CDNSKEY" = 60,
  /** OpenPGP公钥记录 */
  "OPENPGPKEY" = 61,
  /** 绑定HTTPS */
  "HTTPS" = 65,
  /** SPF 记录 */
  "SPF" = 99,
  /** 秘密密钥记录 */
  "TKEY" = 249,
  /** 交易证书 */
  "TSIG" = 250,
  /** 统一资源标识符 */
  "URI" = 256,
  /** 权威认证授权 */
  "CAA" = 257,
  /** DNSSEC 可信权威 */
  "TA" = 32768,
  /** DNSSEC（域名系统安全扩展）来源验证记录 */
  "DLV" = 32769,
}

/**
 * DNS回答记录接口
 * 表示DNS响应中的资源记录（Resource Record）
 */
export type IDnsResolveAnswer = {
  /** DNS 请求的域名 */
  NAME: string;
  /** 类型字段, 例如A类型为1，表示IPv4地址 */
  TYPE: EDnsResolveType;
  /** 类字段，通常为1表示互联网地址 */
  CLASS: number;
  /** 生存时间，单位为秒，表示缓存有效期 */
  TTL: number;
  /** 资源数据长度，单位为字节 */
  RDLENGTH: number;
  /** 资源数据，根据TYPE不同而不同，如A记录为IP地址 */
  RDATA: string;
};

/**
 * DNS查询记录接口
 * 表示DNS请求中的查询部分
 */
export type IDnsResolveQuery = {
  /** 查询名：一般为要查询的域名 */
  QNAME: string;
  /** 查询类型：DNS 查询请求的资源类型。通常查询类型为 A 类型，表示由域名获取对应的 IP 地址。 */
  QTYPE?: EDnsResolveType;
  /** 查询类：地址类型，通常为互联网地址，值为 1。 */
  QCLASS?: number;
};

/**
 * DNS报文接口
 * 表示完整的DNS请求或响应报文
 */
export type IDnsResolve = {
  /** 事务ID，用于匹配请求和响应 */
  id?: number;
  /** 报文中的标志字段，包含各种控制标志 */
  flags?: number;
  /** 问题计数，表示queries数组的长度 */
  count_queries?: number;
  /** 回答资源记录数，表示answers数组的长度 */
  count_answers?: number;
  /** 权威名称服务器计数 */
  count_auth_rr?: number;
  /** 附加资源记录数 */
  count_add_rr?: number;
  /** 查询问题区域，包含所有查询记录 */
  queries: IDnsResolveQuery[];
  /** 资源记录部分，包含所有回答记录 */
  answers?: IDnsResolveAnswer[];
};

/**
 * DNS报文序列化选项接口
 * 用于将DNS报文转换为二进制数据时的选项
 */
export type IDnsResolveStringifyOpt = Omit<IDnsResolve, "answers"> & {
  /** 回答记录数组，但RDATA为Buffer类型而非字符串 */
  answers?: Array<Omit<IDnsResolveAnswer, "RDATA" | "RDLENGTH"> & { RDATA: Buffer }>;
};

/**
 * 获取系统默认DNS服务器
 * 如果没有找到IPv4的DNS服务器，则返回腾讯公共DNS
 * @returns DNS服务器IP地址
 */
export const getDnsServer = () => dns.getServers().find(ip => net.isIPv4(ip)) || "119.29.29.29";

/**
 * DNS服务器类
 * 实现了一个本地DNS服务器，可以拦截和修改DNS请求
 */
export class DnsServer {
  /** 上游DNS服务器IP地址 */
  public dnsServerIp = getDnsServer();
  /** UDP服务器实例，用于接收和发送DNS报文 */
  public udpServer = dgram.createSocket("udp4");
  /**
   * DNS查询回调函数
   * 当本地应用程序请求dns解析时，返回哪个ip
   * 可以被覆盖以实现自定义DNS解析逻辑
   */
  public onDnsLookup = async (query: IDnsResolveQuery, answer: IDnsResolveAnswer | null) =>
    this.hostsMap.get(query.QNAME) ?? answer?.RDATA;
  /** 域名到IP的映射表，类似hosts文件 */
  public hostsMap: Map<string, string>;
  /** DNS服务器监听的主机地址 */
  private udpServerHost: string;

  /**
   * 响应本地应用程序的DNS请求
   * @param msg 接收到的DNS请求报文
   * @param rinfo 远程地址信息
   */
  private async onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    /** 先从上游DNS服务器获取真实的IP */
    const realIps = await dnsResolveRaw(msg, this.dnsServerIp);
    /** 构建answer的域名->IP映射表，方便查找 */
    const realIpsPool: Map<string, IDnsResolveAnswer> = new Map(realIps.answers.map(answer => [answer.NAME, answer]));

    /**
     * 使用递归尝试把CNAME换成A记录
     * @param host 域名
     * @returns 找到的DNS记录，如果没找到则返回null
     */
    const getRealIpByHost = (host: string): IDnsResolveAnswer | null => {
      const realIp = realIpsPool.get(host);
      if (!realIp?.RDATA) {
        return null;
      }
      // 如果是CNAME记录，递归查找对应的A记录
      if (realIp?.TYPE === EDnsResolveType.CNAME) {
        return getRealIpByHost(realIp.RDATA) || realIp;
      }
      return realIp;
    };

    /**
     * 为记录类型添加颜色
     * @param type 记录类型
     * @returns 带颜色的类型字符串
     */
    const colorType = (type: number) => `\x1B[${type ? (type % 5) + 32 : 31}m` + EDnsResolveType[type]?.padEnd(5, " ");

    // 处理每个查询
    for (const query of realIps.queries) {
      const answer = getRealIpByHost(query.QNAME);
      /** 交由开发者自行处理，调用onDnsLookup回调 */
      const realIp = await this.onDnsLookup(query, answer);

      /** 若开发者返回空，则跳过此查询 */
      if (!realIp) {
        continue;
      }

      if (answer) {
        // 如果找到了答案但需要修改IP
        if (answer.RDATA !== realIp) {
          realIps.answers.forEach(ans => {
            if (ans.NAME === answer.NAME) {
              ans.TYPE = EDnsResolveType.A;
              ans.RDATA = realIp;
            }
          });
        }
      } else {
        /** 远端DNS解析失败的域名，直接自定义IP */
        realIps.answers.push({
          NAME: query.QNAME,
          TYPE: EDnsResolveType.A,
          CLASS: 1,
          TTL: 600,
          RDLENGTH: 4,
          RDATA: realIp,
        });
      }

      // 打印DNS解析信息
      console.log(
        "DNS Server\t" +
          colorType(query.QTYPE || 0) +
          "\t" +
          query.QNAME.padEnd(32, " ") +
          "\t\x1B[0m→ " +
          colorType(answer?.TYPE || 0) +
          "\t" +
          answer?.RDATA +
          "\x1B[0m",
      );
    }

    /**
     * 转换资源数据格式
     * 根据不同的记录类型，将字符串格式的RDATA转换为二进制格式
     * @param TYPE 记录类型
     * @param RDATA 资源数据字符串
     * @returns 二进制格式的资源数据
     */
    const RDataStringify = (TYPE: EDnsResolveType, RDATA: string) => {
      const buf = new Buf();
      switch (TYPE) {
        case EDnsResolveType.A:
          // A记录：将点分十进制IP转换为4字节二进制
          return Buffer.from(RDATA.split(".").map(a => Number(a)));
        case EDnsResolveType.CNAME:
          // CNAME记录：将域名转换为DNS格式
          dnsResolveStringifyWriteHostName(RDATA, buf);
          return buf.buffer;
        case EDnsResolveType.MX:
          // MX记录：包含优先级和邮件交换服务器域名
          const { preference, mail_exchange } = JSON.parse(RDATA);
          buf.writeIntBE(Number(preference), 2);
          dnsResolveStringifyWriteHostName(mail_exchange, buf);
          return buf.buffer;
      }
      // 其他类型：直接转换为二进制
      return Buffer.from(RDATA);
    };

    // 发送DNS响应
    this.udpServer.send(
      dnsResolveStringify({
        ...realIps,
        answers: realIps.answers.map(({ NAME, TYPE, CLASS, TTL, RDATA }) => ({
          NAME,
          TYPE,
          CLASS,
          TTL,
          RDATA: RDataStringify(TYPE, RDATA),
        })),
      }),
      rinfo.port,
      rinfo.address,
      err => {
        if (err) {
          console.log("DNS Server\t", err);
          this.udpServer.close();
        }
      },
    );
  }

  /**
   * 杀死占用指定端口的进程
   * @param port 要使用的端口号
   * @param autoSettings 是否自动配置系统DNS
   * @returns Promise，解析为0表示成功
   */
  private killBindPort = (port: number, autoSettings: boolean) =>
    new Promise(r => {
      if (autoSettings) {
        // 查找并杀死占用端口的进程
        getOccupiedNetworkPortPids(port, this.udpServerHost, "UDP")
          .then(pids => {
            pids.forEach(pid => {
              process.kill(pid);
              console.log("DNS Server\t", "杀死进程", "占用端口的进程pid:", pid);
            });
          })
          .finally(() => {
            setTimeout(() => r(0), 1000);
          });
      }

      // 监听服务器启动事件
      this.udpServer.once("listening", () => {
        const addr = this.udpServer.address();
        console.log("DNS Server\t", "启动成功", `${addr.address}:${addr.port}`);
        if (autoSettings) {
          // 自动配置系统DNS服务器
          setDnsAddr(this.udpServerHost)
            .then(networks => {
              networks.forEach(network => console.log("DNS Server\t", "自动配置", network));
            })
            .catch(e => {
              console.log("DNS Server\t", "自动配置失败", e);
            });
        }
      });
    });

  /**
   * 构造函数
   * @param port DNS服务器监听端口，默认为53
   * @param host DNS服务器监听地址，默认为127.0.0.2
   * @param autoSettings 是否自动配置系统DNS，默认为true
   */
  constructor(port: number = 53, host: string = "127.0.0.2", autoSettings: boolean = true) {
    // 避免上游DNS服务器与本地监听地址相同
    if (this.dnsServerIp === host) {
      this.dnsServerIp = "119.29.29.29";
    }
    // 在非Windows系统上添加本地IP别名
    if (os.platform() !== "win32" && host !== "127.0.0.1") {
      child_process.execSync(`ifconfig lo0 alias ${host} netmask 0xFFFFFFFF`);
    }
    console.log("DNS Server\t", "请注意使用【管理员权限】打开");
    console.log("DNS Server\t", "远程地址", this.dnsServerIp);
    this.hostsMap = new Map();
    this.udpServerHost = host;

    // 启动DNS服务器
    this.killBindPort(port, autoSettings).then(() => {
      this.udpServer.bind(port, host);
      this.udpServer.on("message", this.onMessage.bind(this));
    });
  }

  /**
   * 添加自定义域名解析
   * @param ip 要解析到的IP地址
   * @param host 域名
   * @returns 当前的hosts映射表
   */
  public add(ip: string, host: string) {
    this.hostsMap.set(host, ip);
    return this.hostsMap;
  }

  /**
   * 获取域名的真实IP
   * @param host 域名
   * @param dnsServerIp 可选的DNS服务器IP
   * @returns Promise，解析为IP地址
   */
  public getRawIp(host: string, dnsServerIp?: string) {
    return dnsResolve(host, dnsServerIp || this.dnsServerIp);
  }
}

/**
 * 解析DNS报文数据
 * 将二进制DNS报文解析为结构化的对象
 * @param msg DNS报文二进制数据
 * @returns 解析后的DNS报文对象
 */
export const dnsResolveParse = (msg: Buffer): Required<IDnsResolve> => {
  const buf = new Buf(msg);

  /**
   * 解析DNS格式的域名
   * 处理压缩指针和普通域名格式
   * @returns 解析后的域名字符串
   */
  const hostNameParse = () => {
    let len = 0;
    const hostName: string[] = [];
    while ((len = buf.readUIntBE(1))) {
      /** 如果前2位都是1，则使用了压缩指针 */
      if (len >= 0xc0) {
        len = (len - 0xc0) * 256 + buf.readUIntBE(1);
        /** 先保存当前的offset值 */
        const { offset } = buf;
        /** 第一个字节最高两位都是 1，所以只取后14位 */
        buf.offset = len;
        hostName.push(hostNameParse());
        /** 恢复原来的位置 */
        buf.offset = offset;
        /** 压缩只存在于最后一个标签 */
        break;
      }
      /** 没压缩，正常取值 */
      hostName.push(buf.readString(len));
    }
    return hostName.join(".");
  };

  /**
   * 解析资源数据
   * 根据记录类型解析不同格式的资源数据
   * @param buffer 资源数据的二进制表示
   * @param type 记录类型
   * @returns 解析后的资源数据字符串
   */
  const RDataParse = (buffer: Buffer, type: EDnsResolveType): string => {
    switch (type) {
      case EDnsResolveType.A:
        // A记录：将4字节IP转换为点分十进制
        return [...buffer].join(".");
      case EDnsResolveType.CNAME:
        // CNAME记录：解析为域名
        buf.offset -= buffer.length;
        return hostNameParse();
      case EDnsResolveType.MX:
        // MX记录：解析为优先级和邮件交换服务器
        buf.offset -= buffer.length - 2;
        return JSON.stringify({
          preference: buffer.readUInt16BE(),
          mail_exchange: hostNameParse(),
        });
    }
    // 其他类型：直接转换为字符串
    return String(buffer);
  };

  // 解析DNS报文头部
  const dnsResolve: Required<IDnsResolve> = {
    id: buf.readUIntBE(2),
    flags: buf.readUIntBE(2),
    count_queries: buf.readUIntBE(2),
    count_answers: buf.readUIntBE(2),
    count_auth_rr: buf.readUIntBE(2),
    count_add_rr: buf.readUIntBE(2),
    queries: [],
    answers: [],
  };

  // 解析查询部分
  for (let i = 0; i < dnsResolve.count_queries; i++) {
    dnsResolve.queries.push({
      QNAME: hostNameParse(),
      QTYPE: buf.readUIntBE(2),
      QCLASS: buf.readUIntBE(2),
    });
  }

  // 解析回答部分
  for (let i = 0; i < dnsResolve.count_answers; i++) {
    const answer: IDnsResolveAnswer = {
      NAME: hostNameParse(),
      TYPE: buf.readUIntBE(2),
      CLASS: buf.readUIntBE(2),
      TTL: buf.readUIntBE(4),
      RDLENGTH: buf.readUIntBE(2),
      RDATA: "",
    };
    answer.RDATA = RDataParse(buf.read(answer.RDLENGTH), answer.TYPE);
    dnsResolve.answers.push(answer);
  }
  return dnsResolve;
};

/**
 * 将域名写入DNS格式
 * 每个标签前加一个字节表示长度，以0结尾
 * @param QNAME 域名
 * @param buf 目标缓冲区
 */
const dnsResolveStringifyWriteHostName = (QNAME: string, buf: Buf) => {
  (QNAME + (/\.$/.test(QNAME) ? "" : ".")).split(".").forEach(hostname => {
    buf.writeStringPrefix(hostname, len => {
      buf.writeUIntBE(len);
      return undefined;
    });
  });
};

/**
 * 序列化DNS报文数据
 * 将结构化的DNS报文对象转换为二进制格式
 * @param opt DNS报文序列化选项
 * @returns 序列化后的二进制DNS报文
 */
export const dnsResolveStringify = (opt: IDnsResolveStringifyOpt): Buffer => {
  const buf = new Buf();

  // 生成随机ID或使用提供的ID
  const id = opt.id ?? Math.floor(Math.random() * 65536);
  buf.writeUIntBE(id, 2); // dns.id
  buf.writeUIntBE(opt.flags ?? 0x0100, 2); // dns.flags - 标准查询
  buf.writeUIntBE(opt.queries.length, 2); // dns.count.queries
  buf.writeUIntBE(opt.answers?.length || 0, 2); // dns.count.answers
  buf.writeUIntBE(0, 2); // dns.count.auth_rr
  buf.writeUIntBE(0, 2); // dns.count.add_rr

  // 写入查询部分
  for (const { QNAME, QTYPE, QCLASS } of opt.queries) {
    dnsResolveStringifyWriteHostName(QNAME, buf);
    buf.writeUIntBE(QTYPE ?? EDnsResolveType.A, 2); // dns.qry.type
    buf.writeUIntBE(QCLASS ?? 1, 2); // dns.qry.class - 互联网地址
  }

  // 写入回答部分
  for (const { NAME, TYPE, CLASS, TTL, RDATA } of opt?.answers || []) {
    dnsResolveStringifyWriteHostName(NAME, buf);
    buf.writeUIntBE(TYPE ?? EDnsResolveType.A, 2); // 记录类型
    buf.writeUIntBE(CLASS ?? 1, 2); // 类 - 互联网地址
    buf.writeUIntBE(TTL, 4); // 生存时间
    buf.writeUIntBE(RDATA.length, 2); // 资源数据长度
    buf.write(RDATA); // 资源数据
  }
  return buf.buffer;
};

/**
 * 发送DNS查询并获取原始响应
 * @param opt DNS查询选项或原始DNS查询报文
 * @param dnsServerIp DNS服务器IP地址
 * @param dnsServerPort DNS服务器端口，默认为53
 * @returns Promise，解析为DNS响应对象
 */
export const dnsResolveRaw = (
  /** 可传入IDnsResolve对象或者直接传入buffer */
  opt: Omit<IDnsResolve, "count_queries" | "count_answers" | "count_auth_rr" | "count_add_rr" | "answers"> | Buffer,
  dnsServerIp: string,
  dnsServerPort: number = 53,
): Promise<Required<IDnsResolve>> =>
  new Promise((resolve, reject) => {
    // 创建UDP客户端
    const client = dgram.createSocket("udp4");

    // 处理错误
    client.on("error", err => {
      reject(err);
      client.close();
    });

    // 处理响应
    client.on("message", fMsg => {
      resolve(dnsResolveParse(fMsg));
      client.close();
    });

    // 发送查询
    client.send(
      opt instanceof Buffer ? opt : dnsResolveStringify(opt as IDnsResolveStringifyOpt),
      dnsServerPort,
      dnsServerIp,
      err => {
        if (err) {
          reject(err);
          client.close();
        }
      },
    );
  });

/**
 * 解析域名为IP地址
 * 简化版的DNS解析函数，只返回A记录的IP地址
 * @param host 要解析的域名
 * @param dnsServerIp DNS服务器IP，默认使用系统DNS
 * @param dnsServerPort DNS服务器端口，默认为53
 * @returns Promise，解析为IP地址字符串
 */
export const dnsResolve = async (
  host: string,
  dnsServerIp: string = "",
  dnsServerPort: number = 53,
): Promise<string> => {
  // 发送DNS查询
  const { answers } = await dnsResolveRaw({ queries: [{ QNAME: host }] }, dnsServerIp || getDnsServer(), dnsServerPort);

  // 查找A记录
  const RDATA = answers.find(({ TYPE, CLASS }) => CLASS === 1 && TYPE === EDnsResolveType.A)?.RDATA;
  if (!RDATA) {
    throw new Error("没找到" + host + "的IP地址");
  }
  return RDATA;
};

// 测试用例
// dnsResolveRaw(
//   {
//     queries: [{ QNAME: "qq.com", QTYPE: EDnsResolveType.MX }],
//   },
//   "119.29.29.29"
// ).then(a => console.log(a));
// dnsResolveRaw(
//   {
//     queries: [{ QNAME: "www.apple.com" }],
//   },
//   "119.29.29.29"
// ).then(a => console.log(a));

// dnsResolve("www.hejianpeng.cn").then(a => console.log(a));

//new DnsServer().add("127.0.0.1", "0.cn");
// dnsResolveRaw({ queries: [{ QNAME: "dsum.casalemedia.com" }] }, getDnsServer()).then(a => console.log(a));
