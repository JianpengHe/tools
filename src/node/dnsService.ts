import * as dns from "dns";
import * as dgram from "dgram";
import * as net from "net";
import { Buf } from "./Buf";
import { getOccupiedNetworkPortPids, setDnsAddr } from "./systemNetworkSettings";

/** 记录类型，详细介绍：https://zh.wikipedia.org/wiki/DNS%E8%AE%B0%E5%BD%95%E7%B1%BB%E5%9E%8B%E5%88%97%E8%A1%A8 */
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
  "NSEC2" = 50,
  /** NSEC3 参数 */
  "NSEC3" = 51,
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

export type IDnsResolveAnswer = {
  /** DNS 请求的域名 */
  NAME: string;
  /** 类型字段, 若A类型为1 */
  TYPE: EDnsResolveType;
  /** 类字段 */
  CLASS: number;
  /** 生存时间 */
  TTL: number;
  /** 数据长度 */
  RDLENGTH: number;
  /** 资源数据，一般为IP地址 */
  RDATA: string;
};

export type IDnsResolveQuery = {
  /** 查询名：一般为要查询的域名 */
  QNAME: string;
  /** 查询类型：DNS 查询请求的资源类型。通常查询类型为 A 类型，表示由域名获取对应的 IP 地址。 */
  QTYPE?: EDnsResolveType;
  /** 查询类：地址类型，通常为互联网地址，值为 1。 */
  QCLASS?: number;
};

export type IDnsResolve = {
  /** 事务ID */
  id?: number;
  /** 报文中的标志字段 */
  flags?: number;
  /** 问题计数 */
  count_queries?: number;
  /** 回答资源记录数 */
  count_answers?: number;
  /** 权威名称服务器计数 */
  count_auth_rr?: number;
  /** 附加资源记录数 */
  count_add_rr?: number;
  /** 查询问题区域 */
  queries: IDnsResolveQuery[];
  /** 资源记录部分 */
  answers?: IDnsResolveAnswer[];
};

export type IDnsResolveStringifyOpt = Omit<IDnsResolve, "answers"> & {
  answers?: Array<Omit<IDnsResolveAnswer, "RDATA" | "RDLENGTH"> & { RDATA: Buffer }>;
};

export const getDnsServer = () => dns.getServers().find(ip => net.isIPv4(ip)) || "119.29.29.29";

export class DnsServer {
  public dnsServerIp = getDnsServer();
  public udpServer = dgram.createSocket("udp4");
  /** 当本地应用程序请求dns解析时，返回哪个ip */
  public onDnsLookup = async (query: IDnsResolveQuery, answer: IDnsResolveAnswer | null) =>
    this.hostsMap.get(query.QNAME) ?? answer?.RDATA;
  public hostsMap: Map<string, string>;
  private udpServerHost: string;
  /** 响应本地应用程序的DNS请求 */
  private async onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    /** 先拿到真实的ip */
    const realIps = await dnsResolveRaw(msg, this.dnsServerIp);
    /** answer的域名->IP映射表 */
    const realIpsPool: Map<string, IDnsResolveAnswer> = new Map(realIps.answers.map(answer => [answer.NAME, answer]));

    /** 使用递归【尝试】把cname换成A记录 */
    const getRealIpByHost = (host: string): IDnsResolveAnswer | null => {
      const realIp = realIpsPool.get(host);
      if (!realIp?.RDATA) {
        // console.log("-----------");
        // console.log(realIps, realIpsPool, host);
        // console.log("-----------");
        return null;
      }
      if (realIp?.TYPE === EDnsResolveType.CNAME) {
        return getRealIpByHost(realIp.RDATA) || realIp;
      }
      return realIp;
    };
    const colorType = (type: number) => `\x1B[${type ? (type % 5) + 32 : 31}m` + EDnsResolveType[type]?.padEnd(5, " ");
    for (const query of realIps.queries) {
      const answer = getRealIpByHost(query.QNAME);
      /** 交由开发者自行处理 */
      const realIp = await this.onDnsLookup(query, answer);
      console.log(
        "DNS Server\t" +
          colorType(query.QTYPE || 0) +
          "\t" +
          query.QNAME.padEnd(32, " ") +
          "\t\x1B[0m→ " +
          colorType(answer?.TYPE || 0) +
          "\t" +
          answer?.RDATA +
          "\x1B[0m"
      );
      /** 若开发者返回空 */
      if (!realIp) {
        continue;
      }
      if (answer) {
        answer.RDATA = realIp;
      } else {
        /** 远端DNS解析失败的域名，直接自定义ip */
        realIps.answers.push({
          NAME: query.QNAME,
          TYPE: EDnsResolveType.A,
          CLASS: 1,
          TTL: 600,
          RDLENGTH: 4,
          RDATA: realIp,
        });
      }
    }

    /** 转一下格式 */
    const RDataStringify = (TYPE: EDnsResolveType, RDATA: string) => {
      const buf = new Buf();
      switch (TYPE) {
        case EDnsResolveType.A:
          return Buffer.from(RDATA.split(".").map(a => Number(a)));
        case EDnsResolveType.CNAME:
          dnsResolveStringifyWriteHostName(RDATA, buf);
          return buf.buffer;
        case EDnsResolveType.MX:
          const { preference, mail_exchange } = JSON.parse(RDATA);
          buf.writeIntBE(Number(preference), 2);
          dnsResolveStringifyWriteHostName(mail_exchange, buf);
          return buf.buffer;
      }
      return Buffer.from(RDATA);
    };

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
      }
    );
  }
  private killBindPort = (port: number, autoSettings: boolean) =>
    new Promise(r => {
      if (autoSettings) {
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

      this.udpServer.once("listening", () => {
        const addr = this.udpServer.address();
        console.log("DNS Server\t", "启动成功", `${addr.address}:${addr.port}`);
        if (autoSettings) {
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

  constructor(port: number = 53, host: string = "127.0.0.2", autoSettings: boolean = true) {
    if (this.dnsServerIp === host) {
      this.dnsServerIp = "119.29.29.29";
    }
    console.log("DNS Server\t", "请注意使用【管理员权限】打开");
    console.log("DNS Server\t", "远程地址", this.dnsServerIp);
    this.hostsMap = new Map();
    this.udpServerHost = host;
    this.killBindPort(port, autoSettings).then(() => {
      this.udpServer.bind(port, host);
      this.udpServer.on("message", this.onMessage.bind(this));
    });
  }

  public add(ip: string, host: string) {
    this.hostsMap.set(host, ip);
    return this.hostsMap;
  }
  public getRawIp(host: string, dnsServerIp?: string) {
    return dnsResolve(host, dnsServerIp || this.dnsServerIp);
  }
}

/** 解析DNS报文数据 */
export const dnsResolveParse = (msg: Buffer): Required<IDnsResolve> => {
  const buf = new Buf(msg);
  const hostNameParse = () => {
    let len = 0;
    const hostName: string[] = [];
    while ((len = buf.readUIntBE(1))) {
      /** 如果前2位都是1，则使用了压缩 */
      if (len >= 0xc0) {
        len = (len - 0xc0) * 0xff + buf.readUIntBE(1);
        /** 先保存下来当前的offset值 */
        const { offset } = buf;
        /** 第一个字节最高两位都是 1，所以只取后14位 */
        buf.offset = len;
        hostName.push(hostNameParse());
        // console.log(hostName);
        buf.offset = offset;
        /** 压缩只存在于最后一个 */
        break;
      }
      /** 没压缩，正常取值 */
      hostName.push(buf.readString(len));
    }
    return hostName.join(".");
  };
  const RDataParse = (buffer: Buffer, type: EDnsResolveType): string => {
    switch (type) {
      case EDnsResolveType.A:
        return [...buffer].join(".");
      case EDnsResolveType.CNAME:
        buf.offset -= buffer.length;
        return hostNameParse();
      case EDnsResolveType.MX:
        buf.offset -= buffer.length - 2;
        return JSON.stringify({
          preference: buffer.readUInt16BE(),
          mail_exchange: hostNameParse(),
        });
    }
    return String(buffer);
  };
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
  for (let i = 0; i < dnsResolve.count_queries; i++) {
    dnsResolve.queries.push({
      QNAME: hostNameParse(),
      QTYPE: buf.readUIntBE(2),
      QCLASS: buf.readUIntBE(2),
    });
  }
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
/**  */
const dnsResolveStringifyWriteHostName = (QNAME: string, buf: Buf) => {
  (QNAME + (/\.$/.test(QNAME) ? "" : ".")).split(".").forEach(hostname => {
    buf.writeStringPrefix(hostname, len => {
      buf.writeUIntBE(len);
      return undefined;
    });
  });
};

/** 序列化DNS报文数据 */
export const dnsResolveStringify = (opt: IDnsResolveStringifyOpt): Buffer => {
  const buf = new Buf();

  const id = opt.id ?? Math.floor(Math.random() * 65536);
  buf.writeUIntBE(id, 2); // dns.id
  buf.writeUIntBE(opt.flags ?? 0x0100, 2); // dns.flags
  buf.writeUIntBE(opt.queries.length, 2); // dns.count.queries
  buf.writeUIntBE(opt.answers?.length || 0, 2); // dns.count.answers
  buf.writeUIntBE(0, 2); // dns.count.auth_rr
  buf.writeUIntBE(0, 2); // dns.count.add_rr
  for (const { QNAME, QTYPE, QCLASS } of opt.queries) {
    dnsResolveStringifyWriteHostName(QNAME, buf);
    buf.writeUIntBE(QTYPE ?? EDnsResolveType.A, 2); // dns.qry.type
    buf.writeUIntBE(QCLASS ?? 1, 2); // dns.qry.class
  }
  for (const { NAME, TYPE, CLASS, TTL, RDATA } of opt?.answers || []) {
    dnsResolveStringifyWriteHostName(NAME, buf);
    buf.writeUIntBE(TYPE ?? EDnsResolveType.A, 2); // dns.qry.type
    buf.writeUIntBE(CLASS ?? 1, 2); // dns.qry.class
    buf.writeUIntBE(TTL, 4);
    buf.writeUIntBE(RDATA.length, 2);
    buf.write(RDATA);
  }
  return buf.buffer;
};

export const dnsResolveRaw = (
  /** 可传入IDnsResolve对象或者直接传入buffer */
  opt: Omit<IDnsResolve, "count_queries" | "count_answers" | "count_auth_rr" | "count_add_rr" | "answers"> | Buffer,
  dnsServerIp: string,
  dnsServerPort: number = 53
): Promise<Required<IDnsResolve>> =>
  new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    client.on("error", err => {
      reject(err);
      client.close();
    });
    client.on("message", fMsg => {
      resolve(dnsResolveParse(fMsg));
      client.close();
    });
    client.send(opt instanceof Buffer ? opt : dnsResolveStringify(opt), dnsServerPort, dnsServerIp, err => {
      if (err) {
        reject(err);
        client.close();
      }
    });
  });

export const dnsResolve = async (
  host: string,
  dnsServerIp: string = "",
  dnsServerPort: number = 53
): Promise<string> => {
  const { answers } = await dnsResolveRaw({ queries: [{ QNAME: host }] }, dnsServerIp || getDnsServer(), dnsServerPort);
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
