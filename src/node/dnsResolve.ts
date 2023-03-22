import * as dns from "dns";
import * as dgram from "dgram";
import * as net from "net";
import { Buf } from "./Buf";

export enum EDnsResolveType {
  /** IPv4地址 */
  "A" = 1,
  /** 名字服务器 */
  "NS" = 2,
  /** 规范名称定义主机的正式名字的别名 */
  "CNAME" = 5,
  /** 开始授权标记一个区的开始 */
  "SOA" = 6,
  /** 熟知服务定义主机提供的网络服务 */
  "WKS" = 11,
  /** 指针把IP地址转化为域名 */
  "PTR" = 12,
  /** 主机信息给出主机使用的硬件和操作系统的表述 */
  "HINFO" = 13,
  /** 邮件交换把邮件改变路由送到邮件服务器 */
  "MX" = 15,
  /** IPv6地址 */
  "AAAA" = 28,
  /** 传送整个区的请求 */
  "AXFR" = 252,
  /** 对所有记录的请求 */
  "ANY" = 255,
}

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
  queries: {
    /** 查询名：一般为要查询的域名 */
    QNAME: string;
    /** 查询类型：DNS 查询请求的资源类型。通常查询类型为 A 类型，表示由域名获取对应的 IP 地址。 */
    QTYPE?: EDnsResolveType;
    /** 查询类：地址类型，通常为互联网地址，值为 1。 */
    QCLASS?: number;
  }[];
  /** 资源记录部分 */
  answers?: {
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
  }[];
};
/** 解析DNS报文数据 */
export const dnsResolveParse = (msg: Buffer): Required<IDnsResolve> => {
  const buf = new Buf(msg);
  const hostNameParse = (maxLen: number = buf.buffer.length) => {
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
        hostName.push(hostNameParse(maxLen));
        buf.offset = offset;
        /** 压缩只存在于最后一个 */
        break;
      }
      /** 没压缩，正常取值 */
      hostName.push(buf.readString(len));
      if ((maxLen -= len + 1) <= 0) {
        break;
      }
    }
    return hostName.join(".");
  };
  const RDataParse = (buffer: Buffer, type: EDnsResolveType): string => {
    switch (type) {
      case EDnsResolveType.A:
        return [...buffer].join(".");
      case EDnsResolveType.CNAME:
        buf.offset -= buffer.length;
        return hostNameParse(buffer.length);
      case EDnsResolveType.MX:
        buf.offset -= buffer.length - 2;
        return JSON.stringify({
          preference: buffer.readUInt16BE(),
          mail_exchange: hostNameParse(buffer.length),
        });
    }
    return "";
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
    const answer: Required<IDnsResolve>["answers"][0] = {
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

/** 序列化DNS报文数据 */
export const dnsResolveStringify = (
  opt: Omit<IDnsResolve, "answers"> & {
    answers?: Array<Omit<Required<IDnsResolve>["answers"][0], "RDATA" | "RDLENGTH"> & { RDATA: Buffer }>;
  }
): Buffer => {
  const buf = new Buf();
  const writeHostName = (QNAME: string) => {
    (QNAME + (/\.$/.test(QNAME) ? "" : ".")).split(".").forEach(hostname => {
      buf.writeStringPrefix(hostname, len => {
        buf.writeUIntBE(len);
        return undefined;
      });
    });
  };
  const id = opt.id ?? Math.floor(Math.random() * 65536);
  buf.writeUIntBE(id, 2); // dns.id
  buf.writeUIntBE(opt.flags ?? 0x0100, 2); // dns.flags
  buf.writeUIntBE(opt.queries.length, 2); // dns.count.queries
  buf.writeUIntBE(opt.answers?.length || 0, 2); // dns.count.answers
  buf.writeUIntBE(0, 2); // dns.count.auth_rr
  buf.writeUIntBE(0, 2); // dns.count.add_rr
  for (const { QNAME, QTYPE, QCLASS } of opt.queries) {
    writeHostName(QNAME);
    buf.writeUIntBE(QTYPE ?? EDnsResolveType.A, 2); // dns.qry.type
    buf.writeUIntBE(QCLASS ?? 1, 2); // dns.qry.class
  }
  for (const { NAME, TYPE, CLASS, TTL, RDATA } of opt?.answers || []) {
    writeHostName(NAME);
    buf.writeUIntBE(TYPE ?? EDnsResolveType.A, 2); // dns.qry.type
    buf.writeUIntBE(CLASS ?? 1, 2); // dns.qry.class
    buf.writeUIntBE(TTL, 4);
    buf.writeUIntBE(RDATA.length, 2);
    buf.write(RDATA);
  }
  return buf.buffer;
};

export const dnsResolveRaw = (
  opt: Omit<IDnsResolve, "count_queries" | "count_answers" | "count_auth_rr" | "count_add_rr" | "answers">,
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
    client.send(dnsResolveStringify(opt), dnsServerPort, dnsServerIp, err => {
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
  const { answers } = await dnsResolveRaw(
    { queries: [{ QNAME: host }] },
    dnsServerIp || dns.getServers().find(ip => net.isIP(ip)) || "",
    dnsServerPort
  );
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
