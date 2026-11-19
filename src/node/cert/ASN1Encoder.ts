/**
 * ASN1Encoder.ts - ASN.1 DER & PEM 编解码器 (底层密码学数据协议支持)
 *
 * X.509 证书规范 (RFC 5280) 在底层严格使用 ASN.1 (Abstract Syntax Notation One) 定义数据结构，
 * 并采用 DER (Distinguished Encoding Rules，唯一编码规则，采用 TLV 结构: Tag-Length-Value) 序列化为二进制流。
 *
 * 本模块实现了无需第三方依赖的纯 TypeScript 轻量级 ASN.1 DER 编解码器：
 * - 基础类型编码：INTEGER, BIT STRING, OCTET STRING, UTF8String, UTCTime / GeneralizedTime 等；
 * - 复合结构封装：SEQUENCE, SET；
 * - X.509 专用扩展条目封装：dNSName, iPAddress (支持 IPv4、IPv6 压缩与映射格式)；
 * - PEM 格式转换：DER 与标准 PEM 字符串互转 (RFC 7468)；
 * - ASN.1 TLV 解析器：支持从 PEM / DER 格式证书中无损提取 Subject / Issuer 等原生 DER 字节。
 */

import * as net from "net";
import * as url from "url";

export class ASN1Encoder {
  /**
   * 编码长度字段 (Length)
   *
   * ASN.1 DER 长度编码规则：
   * - 短格式 (Short Form): 当长度 < 128 (0x80) 时，直接使用 1 个字节表示；
   * - 长格式 (Long Form): 当长度 >= 128 时，首字节最高位置 1 (0x80 | 字节数)，后续字节为大端序表示的实际长度数值。
   *
   * @param len 数据内容的字节长度
   * @returns 编码后的 Length 字段 Buffer
   */
  public static encodeLength(len: number): Buffer {
    if (len < 128) return Buffer.from([len]);
    const hex = len.toString(16);
    const padded = hex.length % 2 === 0 ? hex : "0" + hex;
    const buf = Buffer.from(padded, "hex");
    // 0x80 | buf.length 表示这是一个长格式长度，后续有 buf.length 个字节代表真实长度
    return Buffer.concat([Buffer.from([0x80 | buf.length]), buf]);
  }

  /**
   * 构造 SEQUENCE 结构 (Tag: 0x30, 复合类型)
   * 用于将多个有序的 ASN.1 元素组合成一个列表，例如 TBSCertificate、Validity、Extensions 等
   *
   * @param buffers 子元素的 DER Buffer 列表
   * @returns 封装好的 SEQUENCE DER Buffer
   */
  public static sequence(...buffers: Buffer[]): Buffer {
    const content = Buffer.concat(buffers);
    return Buffer.concat([Buffer.from([0x30]), this.encodeLength(content.length), content]);
  }

  /**
   * 构造 SET 结构 (Tag: 0x31, 复合类型)
   * 类似于 SEQUENCE，但在 ASN.1 中表示无序集合。在 X.509 的 Subject / Issuer 中常用于包裹相对区别名 (RDN)
   *
   * @param buffers 子元素的 DER Buffer 列表
   * @returns 封装好的 SET DER Buffer
   */
  public static set(...buffers: Buffer[]): Buffer {
    const content = Buffer.concat(buffers);
    return Buffer.concat([Buffer.from([0x31]), this.encodeLength(content.length), content]);
  }

  /**
   * 构造 INTEGER 结构 (Tag: 0x02, 基本类型)
   *
   * ASN.1 整数编码规则：
   * 1. 采用大端序补码表示；
   * 2. 剥离高位多余的 0x00 前导字节（至少保留一个字节）；
   * 3. 整数是有符号的，若最高有效位为 1 (即 buf[0] & 0x80)，为防止被误识别为负数，必须在前置追加一个 0x00 字节表示正数。
   *
   * @param numBuf 整数的大端序 Buffer（如随机生成的证书序列号 Serial Number）
   * @returns 封装好的 INTEGER DER Buffer
   */
  public static integer(numBuf: Buffer): Buffer {
    let start = 0;
    while (start < numBuf.length - 1 && numBuf[start] === 0) start++;
    numBuf = numBuf.subarray(start);
    if (numBuf[0] & 0x80) numBuf = Buffer.concat([Buffer.from([0x00]), numBuf]);
    return Buffer.concat([Buffer.from([0x02]), this.encodeLength(numBuf.length), numBuf]);
  }

  /**
   * 构造 BIT STRING 结构 (Tag: 0x03, 基本类型)
   * 用于存储位字符串数据（如公钥数据、数字签名值、Key Usage 标志位）。
   *
   * @param buf 位字符串数据 Buffer
   * @param unusedBits 最后一个字节中未使用的 bit 位数 (0-7)，默认为 0
   * @returns 封装好的 BIT STRING DER Buffer
   */
  public static bitString(buf: Buffer, unusedBits: number = 0): Buffer {
    return Buffer.concat([Buffer.from([0x03]), this.encodeLength(buf.length + 1), Buffer.from([unusedBits]), buf]);
  }

  /**
   * 构造 OCTET STRING 结构 (Tag: 0x04, 基本类型)
   * 用于存储任意八位字节序列（如 X.509 扩展项的 extnValue 内容）
   *
   * @param buf 字节数据 Buffer
   * @returns 封装好的 OCTET STRING DER Buffer
   */
  public static octetString(buf: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0x04]), this.encodeLength(buf.length), buf]);
  }

  /**
   * 构造 UTF8 STRING 结构 (Tag: 0x0C, 基本类型)
   * 用于以 UTF-8 编码存储可变长度文本（如证书主题的 Common Name）
   *
   * @param str 文本字符串
   * @returns 封装好的 UTF8String DER Buffer
   */
  public static utf8String(str: string): Buffer {
    const buf = Buffer.from(str, "utf8");
    return Buffer.concat([Buffer.from([0x0c]), this.encodeLength(buf.length), buf]);
  }

  /**
   * 构造 UTCTime / GeneralizedTime 结构
   *
   * 遵循 RFC 5280 时间规范：
   * - 2050 年以前必须使用 UTCTime (Tag: 0x17)，格式为 YYMMDDHHMMSSZ；
   * - 2050 年及以后必须使用 GeneralizedTime (Tag: 0x18)，格式为 YYYYMMDDHHMMSSZ。
   * 时间统一采用 UTC/GMT 时区（以 'Z' 结尾）。
   *
   * @param date Date 时间对象
   * @returns 封装好的时间 DER Buffer
   */
  public static utcTime(date: Date): Buffer {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const fullYear = date.getUTCFullYear();
    const timeStr = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
      date.getUTCHours(),
    )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    // RFC 5280: 2050 年以前使用 UTCTime (0x17)，2050 年及以后使用 GeneralizedTime (0x18)
    if (fullYear < 2050) {
      const buf = Buffer.from(`${fullYear.toString().slice(-2)}${timeStr}`, "ascii");
      return Buffer.concat([Buffer.from([0x17]), this.encodeLength(buf.length), buf]);
    }
    const buf = Buffer.from(`${fullYear}${timeStr}`, "ascii");
    return Buffer.concat([Buffer.from([0x18]), this.encodeLength(buf.length), buf]);
  }

  /**
   * 构造 SAN (Subject Alternative Name) 扩展项中的 dNSName 条目
   * ASN.1 Context-Specific Tag [2] 隐式标记 (0x82 = 0x80 | 0x02)。
   * 支持通过 url.domainToASCII 将中文等国际化域名自动转换为 Punycode ASCII 格式。
   *
   * @param domain 域名字符串（如 "example.com"、"*.example.com" 或 "中文.com"）
   * @returns 封装好的 dNSName DER Buffer
   */
  public static dNSName(domain: string): Buffer {
    const ascii = url.domainToASCII(domain) || domain;
    const buf = Buffer.from(ascii, "ascii");
    // Context-specific (tag 2) 0x82 表示 SAN 里的 dNSName
    return Buffer.concat([Buffer.from([0x82]), this.encodeLength(buf.length), buf]);
  }

  /**
   * 构造 SAN (Subject Alternative Name) 扩展项中的 iPAddress 条目
   * ASN.1 Context-Specific Tag [7] 隐式标记 (0x87 = 0x80 | 0x07)。
   * 支持 IPv4 (4 字节大端序) 与 IPv6 (16 字节大端序，支持 "::" 压缩与 IPv4 映射的 IPv6 地址格式)。
   *
   * @param ip IP 地址字符串（如 "127.0.0.1"、"::1" 等）
   * @returns 封装好的 iPAddress DER Buffer
   */
  public static ipAddress(ip: string): Buffer {
    let buf: Buffer;
    if (net.isIPv4(ip)) {
      buf = Buffer.from(ip.split(".").map(Number));
    } else {
      let cleanIp = ip;
      if (cleanIp.includes(".")) {
        const lastColon = cleanIp.lastIndexOf(":");
        const v4 = cleanIp
          .slice(lastColon + 1)
          .split(".")
          .map(Number);
        const hex = ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
        cleanIp = cleanIp.slice(0, lastColon + 1) + hex;
      }
      const parts = cleanIp.split("::");
      const left = parts[0] ? parts[0].split(":").map(h => parseInt(h, 16)) : [];
      const right = parts[1] !== undefined ? (parts[1] ? parts[1].split(":").map(h => parseInt(h, 16)) : []) : null;
      const full = right !== null ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
      buf = Buffer.alloc(16);
      full.forEach((v, i) => buf.writeUInt16BE(v, i * 2));
    }
    // Context-specific (tag 7) 0x87 表示 SAN 里的 iPAddress
    return Buffer.concat([Buffer.from([0x87]), this.encodeLength(buf.length), buf]);
  }

  /**
   * 将 DER 二进制字节流封装为标准 PEM 文本格式
   * 按照 RFC 7468 标准进行 Base64 编码，每行截断为 64 个字符，并添加首尾边界标头。
   *
   * @param type 实体类型名称（如 "CERTIFICATE"、"PRIVATE KEY"）
   * @param der DER 编码的二进制 Buffer
   * @returns 标准 PEM 格式文本字符串
   */
  public static toPem(type: string, der: Buffer): string {
    const b64 = der.toString("base64");
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
  }

  /**
   * 从证书 (PEM 字符串或 DER Buffer) 中解析并提取 Subject Name 的 ASN.1 DER 编码
   *
   * 解析原理：
   * 1. 若输入为 PEM 字符串，则剥离 BEGIN/END 标头并 Base64 解码为 DER 二进制；
   * 2. 通过简易 TLV 解码器定位 Certificate -> TBSCertificate；
   * 3. 在 TBSCertificate 中顺序定位各字段 (version, serial, sigAlg, issuer, validity, subject)；
   * 4. 提取 Subject 字段的原始 DER 字节，直接作为服务端证书签发时的 Issuer 字段，确保二进制一致性。
   *
   * @param cert PEM 文本或 DER Buffer 证书
   * @returns Subject Name 字段的 ASN.1 DER Buffer
   */
  public static extractSubject(cert: string | Buffer): Buffer {
    let der: Buffer;
    if (typeof cert === "string") {
      const b64 = cert.replace(/-----[^\n\r]+-----/g, "").replace(/[\s\r\n]+/g, "");
      der = Buffer.from(b64, "base64");
    } else if (cert.subarray(0, 30).toString("ascii").includes("-----BEGIN")) {
      const b64 = cert
        .toString("utf8")
        .replace(/-----[^\n\r]+-----/g, "")
        .replace(/[\s\r\n]+/g, "");
      der = Buffer.from(b64, "base64");
    } else {
      der = cert;
    }
    const readTLV = (pos: number) => {
      const start = pos;
      const tag = der[pos++];
      let len = der[pos++];
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = (len << 8) | der[pos++];
      }
      return { tag, valStart: pos, end: pos + len, raw: der.subarray(start, pos + len) };
    };
    const certTLV = readTLV(0);
    const tbs = readTLV(certTLV.valStart);
    let pos = tbs.valStart;
    const elements: Array<{ tag: number; raw: Buffer; end: number }> = [];
    while (pos < tbs.end) {
      const el = readTLV(pos);
      elements.push(el);
      pos = el.end;
    }
    // TBSCertificate: [0] version (0xa0, 可选), serial, sigAlg, issuer, validity, subject
    const hasVersion = elements[0].tag === 0xa0;
    return elements[hasVersion ? 5 : 4].raw;
  }
}

// ============================================================================
// 测试用例 / 使用示例: 基础 ASN.1 编码构建与 PEM 封装
// ============================================================================
/**
 * 演示：
 * 1. 构造标准 INTEGER、UTF8String、UTCTime、SAN (dNSName / iPAddress)；
 * 2. 嵌套组装为 SEQUENCE 结构；
 * 3. 将二进制 DER 字节流转换为标准 PEM 字符串；
 * 4. 验证 ASN.1 Length 的短格式与长格式编码。
 *
 * 如需调试测试，可解除下方对应代码块的注释直接运行。
 */
// (async () => {
//   console.log("=== 测试 ASN.1 编解码器 ===");
//
//   // 1. 编码通用数据类型
//   const serial = ASN1Encoder.integer(Buffer.from([0x01, 0x02, 0x03, 0x04]));
//   const commonName = ASN1Encoder.utf8String("example.com");
//   const now = ASN1Encoder.utcTime(new Date());
//   const dns = ASN1Encoder.dNSName("中文测试.cn"); // 自动 Punycode 转换
//   const ipv4 = ASN1Encoder.ipAddress("192.168.1.1");
//   const ipv6 = ASN1Encoder.ipAddress("::1");
//
//   // 2. 组装为 SEQUENCE 列表
//   const sampleSequence = ASN1Encoder.sequence(serial, commonName, now, dns, ipv4, ipv6);
//   console.log("Sequence DER 字节长度:", sampleSequence.length);
//   console.log("Sequence DER 十六进制:", sampleSequence.toString("hex"));
//
//   // 3. 封装为 PEM 格式
//   const samplePem = ASN1Encoder.toPem("SAMPLE DATA", sampleSequence);
//   console.log("\n生成 PEM 输出:\n" + samplePem);
// })();
