/**
 * CertGenerator.ts - X.509 数字证书生成与动态 SNI 管理工具
 *
 * 本文件基于 Node.js 原生模块 (crypto, tls, net, fs, child_process 等) 实现了轻量级 X.509 证书的生成与管理，
 * 不依赖 openssl 外部命令行程序即可纯代码生成符合 RFC 5280 规范的 X.509 v3 证书。
 *
 * 核心功能模块：
 * 1. ASN1Encoder: ASN.1 DER (Distinguished Encoding Rules) 与 PEM 格式编解码器
 * 2. CertGenerator:
 *    - createRootCA: 生成自签名的 CA 根证书与私钥 (RSA-2048, SHA-256)
 *    - createServerCert: 使用 CA 私钥签发服务器证书，支持普通域名、泛域名 (*.xxx)、多域名、中文域名 (IDN / Punycode)、IPv4 与 IPv6
 *    - trustCaInWindows: 自动调用 Windows certutil 将 CA 证书导入系统“受信任的根证书颁发机构”（支持 UAC 提权）
 * 3. createSNICallback: 为 HTTPS / TLS 服务器提供动态 SNI (Server Name Indication) 回调，支持按需动态生成证书、本地磁盘持久化、内存防击穿与 LRU 缓存管理
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import * as util from "util";
import * as net from "net";
import * as url from "url";
import * as os from "os";
import * as tls from "tls";

/**
 * ============================================================================
 * 1. ASN.1 DER & PEM 编码工具 (底层协议支持)
 * ============================================================================
 * X.509 证书在底层采用 ASN.1 (Abstract Syntax Notation One) 定义数据结构，
 * 并使用 DER (Distinguished Encoding Rules，唯一编码规则，TLV 格式: Tag-Length-Value) 序列化为二进制。
 * 本类实现了证书所需的关键 ASN.1 类型编码方法。
 */
class ASN1Encoder {
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

/**
 * 异步生成 2048 位 RSA 密钥对
 * 基于 Node.js crypto.generateKeyPair 避免阻塞主事件循环
 *
 * @returns 包含公钥与私钥 KeyObject 的 Promise
 */
const generateRsaKey = () =>
  new Promise<{ publicKey: crypto.KeyObject; privateKey: crypto.KeyObject }>((resolve, reject) =>
    crypto.generateKeyPair("rsa", { modulusLength: 2048 }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ privateKey, publicKey });
    }),
  );

/**
 * ============================================================================
 * 2. 证书生成逻辑核心
 * ============================================================================
 * 包含 CA 根证书生成、服务器证书签发以及 Windows 根证书信任安装等功能。
 */
export class CertGenerator {
  /**
   * 常用 ASN.1 对象标识符 (OID - Object Identifier) 的 DER 编码常量
   * Tag 均为 0x06 (OBJECT IDENTIFIER)
   */
  private static readonly OID = {
    /** 签名算法: sha256WithRSAEncryption (1.2.840.113549.1.1.11) */
    SHA256_RSA: Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    /** 主题属性: Common Name / 常用名称 (2.5.4.3 / id-at-commonName) */
    COMMON_NAME: Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
    /** 标准扩展: Key Usage / 密钥用法 (2.5.29.15 / id-ce-keyUsage) */
    KEY_USAGE: Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]), // 2.5.29.15
    /** 标准扩展: Basic Constraints / 基本约束 (2.5.29.19 / id-ce-basicConstraints) */
    BASIC_CONSTRAINTS: Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13]),
    /** 标准扩展: Subject Alternative Name / 主题备用名称 (2.5.29.17 / id-ce-subjectAltName) */
    SAN: Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]),
    /** 标准扩展: Extended Key Usage / 增强型密钥用法 (2.5.29.37 / id-ce-extKeyUsage) */
    EKU: Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x25]),
    /** 增强密钥用法目的: Server Authentication / 服务器身份验证 (1.3.6.1.5.5.7.3.1 / id-kp-serverAuth) */
    SERVER_AUTH: Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]),
  };

  /**
   * 生成 CA 根证书及私钥 (自签名 X.509 v3 证书)
   *
   * 构造规范 (符合 RFC 5280)：
   * 1. 密钥规格: RSA 2048 位
   * 2. 签名算法: SHA-256 with RSA (sha256WithRSAEncryption)
   * 3. 基本约束 (Basic Constraints): CA:TRUE (Critical)
   * 4. 密钥用法 (Key Usage): digitalSignature, keyCertSign (签发证书), cRLSign (签发吊销列表) (Critical)
   * 5. 颁发者与主题: 自签名，Issuer 与 Subject 均为指定的 commonName
   *
   * @param commonName CA 根证书的主体名称 (Common Name)，例如 "My Root CA"
   * @param years 证书有效期（单位：年），默认为 10 年
   * @returns 返回生成的 CA 密钥及证书对象：
   *   - `caKeyObj`: 内存中的 KeyObject 私钥对象，用于后续直接为服务端证书签名
   *   - `caNameDer`: CA 主体名称的 ASN.1 DER 编码 Buffer，签发服务端证书时作为 Issuer
   *   - `caKeyPem`: PKCS#8 格式的私钥 PEM 字符串
   *   - `caCertPem`: X.509 格式的根证书 PEM 字符串
   *   - `expiry`: 证书过期时间戳（毫秒）
   */
  public static async createRootCA(commonName: string, years: number = 10) {
    // 1. 生成 CA 密钥对
    const { privateKey, publicKey } = await generateRsaKey();
    const pubKeyDer = publicKey.export({ type: "spki", format: "der" });

    // 2. 构造 TBS (To Be Signed)
    const version = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]); // v3
    const serial = ASN1Encoder.integer(crypto.randomBytes(8));
    const sigAlg = ASN1Encoder.sequence(this.OID.SHA256_RSA, Buffer.from([0x05, 0x00])); // Alg + NULL
    const name = ASN1Encoder.sequence(
      ASN1Encoder.set(ASN1Encoder.sequence(this.OID.COMMON_NAME, ASN1Encoder.utf8String(commonName))),
    );

    const now = new Date();
    const expiry = new Date();
    expiry.setUTCFullYear(now.getUTCFullYear() + years);
    const validity = ASN1Encoder.sequence(ASN1Encoder.utcTime(now), ASN1Encoder.utcTime(expiry));

    // Basic Constraints: CA:TRUE (Critical)
    const isCritical = Buffer.from([0x01, 0x01, 0xff]);
    const caTrueSeq = ASN1Encoder.sequence(Buffer.from([0x01, 0x01, 0xff]));
    const bcExt = ASN1Encoder.sequence(this.OID.BASIC_CONSTRAINTS, isCritical, ASN1Encoder.octetString(caTrueSeq));

    // Key Usage: digitalSignature (0), keyCertSign (5), cRLSign (6) => 0x86, 1 unused bit (Critical)
    const caKuExt = ASN1Encoder.sequence(
      this.OID.KEY_USAGE,
      isCritical,
      ASN1Encoder.octetString(ASN1Encoder.bitString(Buffer.from([0x86]), 1)),
    );

    const extensions = ASN1Encoder.sequence(bcExt, caKuExt);
    const extContext = Buffer.concat([Buffer.from([0xa3]), ASN1Encoder.encodeLength(extensions.length), extensions]);

    const tbs = ASN1Encoder.sequence(version, serial, sigAlg, name, validity, name, pubKeyDer, extContext);

    // 3. 签名并包装
    const signature = crypto.sign("sha256", tbs, privateKey);
    const certDer = ASN1Encoder.sequence(tbs, sigAlg, ASN1Encoder.bitString(signature));

    return {
      caKeyObj: privateKey, // 保持内存中的对象引用，用于后续给 Server 签名
      caNameDer: name, // 保留 CA 主体名称的 DER，给 Server Issuer 用
      caKeyPem: ASN1Encoder.toPem("PRIVATE KEY", privateKey.export({ type: "pkcs8", format: "der" })),
      caCertPem: ASN1Encoder.toPem("CERTIFICATE", certDer),
      expiry: expiry.getTime(),
    };
  }

  /**
   * 生成服务器证书及私钥（由指定的 CA 签发）
   *
   * 特性支持：
   * 1. 域名与 IP：支持单域名、多域名、泛域名 (*.example.com)、localhost、IPv4 与 IPv6；
   * 2. 中文域名：自动将中文等国际化域名 (IDN) 转换为 Punycode ASCII 格式；
   * 3. X.509 v3 扩展：
   *    - Basic Constraints: CA:FALSE
   *    - Key Usage: digitalSignature (数字签名), keyEncipherment (密钥加密) (Critical)
   *    - Subject Alternative Name (SAN): 完整写入所有指定的 DNS 域名与 IP 地址
   *    - Extended Key Usage (EKU): Server Authentication (id-kp-serverAuth)
   * 4. 证书链：返回的 cert 包含服务端证书及传入的 CA 根证书，形成完整链条。
   *
   * @param domain 域名或 IP，支持单个字符串（支持逗号/空格分隔多个）或字符串数组
   * @param caKey CA 私钥，可为 KeyObject 对象、PEM 格式文本或 DER Buffer
   * @param caCertOrNameDer CA 根证书 PEM 文本或 CA Subject 的 DER Buffer
   * @param years 服务器证书有效期（单位：年），默认为 1 年
   * @returns 返回包含服务器私钥及完整证书链的对象：
   *   - `key`: PKCS#8 格式的服务器私钥 PEM 字符串
   *   - `cert`: 完整的证书链 PEM 字符串 (服务器证书 + CA 证书)
   *   - `expiry`: 证书过期时间戳（毫秒）
   */
  public static async createServerCert(
    domain: string | string[],
    caKey: crypto.KeyObject | string | Buffer,
    caCertOrNameDer: Buffer | string,
    years: number = 1,
  ) {
    const caKeyObj = caKey instanceof crypto.KeyObject ? caKey : crypto.createPrivateKey(caKey);
    const caNameDer =
      typeof caCertOrNameDer === "string" || caCertOrNameDer.subarray(0, 30).toString("ascii").includes("-----BEGIN")
        ? ASN1Encoder.extractSubject(caCertOrNameDer)
        : caCertOrNameDer;

    // 1. 生成服务器密钥对
    const { privateKey, publicKey } = await generateRsaKey();
    const pubKeyDer = publicKey.export({ type: "spki", format: "der" });

    // 2. 构造 TBS
    const version = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]); // v3
    const serial = ASN1Encoder.integer(crypto.randomBytes(8));
    const sigAlg = ASN1Encoder.sequence(this.OID.SHA256_RSA, Buffer.from([0x05, 0x00]));

    // 解析并标准化传入的域名/IP列表，构造 SAN 与 Common Name
    const rawList = (Array.isArray(domain) ? domain : [domain])
      .flatMap(d => d.split(/[,;\s]+/))
      .map(d => d.trim())
      .filter(Boolean);

    const sanBuffers: Buffer[] = [];
    const added = new Set<string>();
    let commonName = "";

    for (const item of rawList) {
      const target = url.domainToASCII(item) || item;
      if (!commonName) commonName = target;
      if (!added.has(target)) {
        added.add(target);
        sanBuffers.push(net.isIP(item) ? ASN1Encoder.ipAddress(item) : ASN1Encoder.dNSName(target));
      }
    }

    if (sanBuffers.length === 0) throw new Error("At least one valid domain or IP is required");

    // Server Subject
    const subjectDer = ASN1Encoder.sequence(
      ASN1Encoder.set(ASN1Encoder.sequence(this.OID.COMMON_NAME, ASN1Encoder.utf8String(commonName))),
    );

    const now = new Date();
    const expiry = new Date();
    expiry.setUTCFullYear(now.getUTCFullYear() + years);
    const validity = ASN1Encoder.sequence(ASN1Encoder.utcTime(now), ASN1Encoder.utcTime(expiry));

    // 扩展项配置
    // - Basic Constraints: CA:FALSE
    const bcExt = ASN1Encoder.sequence(this.OID.BASIC_CONSTRAINTS, ASN1Encoder.octetString(ASN1Encoder.sequence()));

    // - Key Usage: digitalSignature (0), keyEncipherment (2) => 0xa0, 5 unused bits (Critical)
    const isCritical = Buffer.from([0x01, 0x01, 0xff]);
    const serverKuExt = ASN1Encoder.sequence(
      this.OID.KEY_USAGE,
      isCritical,
      ASN1Encoder.octetString(ASN1Encoder.bitString(Buffer.from([0xa0]), 5)),
    );

    // - SAN: 支持 IP、主域名、泛域名等
    const sanExt = ASN1Encoder.sequence(this.OID.SAN, ASN1Encoder.octetString(ASN1Encoder.sequence(...sanBuffers)));
    // - EKU: Server Auth
    const ekuExt = ASN1Encoder.sequence(
      this.OID.EKU,
      ASN1Encoder.octetString(ASN1Encoder.sequence(this.OID.SERVER_AUTH)),
    );

    const extensions = ASN1Encoder.sequence(bcExt, serverKuExt, sanExt, ekuExt);
    const extContext = Buffer.concat([Buffer.from([0xa3]), ASN1Encoder.encodeLength(extensions.length), extensions]);

    // 组装 TBS
    // 注意：这里的 Issuer 必须直接使用 CA 的 caNameDer，确保证书链校验一致
    const tbs = ASN1Encoder.sequence(version, serial, sigAlg, caNameDer, validity, subjectDer, pubKeyDer, extContext);

    // 3. 使用内存中的 CA 私钥对 Server 证书签名
    const signature = crypto.sign("sha256", tbs, caKeyObj);
    const certDer = ASN1Encoder.sequence(tbs, sigAlg, ASN1Encoder.bitString(signature));

    return {
      key: ASN1Encoder.toPem("PRIVATE KEY", privateKey.export({ type: "pkcs8", format: "der" })),
      cert: ASN1Encoder.toPem("CERTIFICATE", certDer) + String(caCertOrNameDer),
      expiry: expiry.getTime(),
    };
  }

  /**
   * 将 CA 根证书安装并信任到 Windows 系统证书库中
   *
   * 安装流程：
   * 1. 优先调用 Windows 原生 `certutil.exe -addstore -f root <certPath>` 命令；
   *    若当前 Node.js 具备管理员权限，则直接静默安装；
   * 2. 若退出码为 0x0005 (ERROR_ACCESS_DENIED / 权限不足)，则通过 PowerShell 启动带有 `-Verb RunAs` 的进程，
   *    弹出 Windows UAC 对话框向用户申请管理员授权；
   * 3. 采用 UTF-16LE + Base64 `-EncodedCommand` 执行，防止路径中的空格与引号被转义破坏。
   *
   * @param caPath CA 根证书文件路径
   * @returns 安装成功返回 true，用户拒绝或安装失败返回 false
   */
  public static async trustCaInWindows(caPath: string) {
    const certPath = path.isAbsolute(caPath) ? caPath : path.resolve("./", caPath);
    const execFileAsync = util.promisify(childProcess.execFile);
    console.log("尝试安装证书...", certPath);

    // 1. 优先使用 execFile 直接执行（若当前已是管理员则静默成功，无需 cmd.exe 且天然支持空格路径）
    let exitCode = 0;
    try {
      await execFileAsync("certutil.exe", ["-addstore", "-f", "root", certPath]);
      console.log("【成功】证书已静默安装！（当前已具备管理员权限）");
      return true;
    } catch (e: any) {
      exitCode = e.code;
    }
    /** 0x0005 表示权限不足，需要 UAC 提权 */
    if ((exitCode & 0xffff) !== 0x0005) {
      console.log("【失败】无法安装证书", certPath, exitCode);
      return false;
    }

    try {
      // 2. 使用 PowerShell 弹出 UAC 提权窗口
      // 注意：PowerShell Start-Process -ArgumentList 在传参时若有空格会被拆分，必须在参数内包裹双引号 ('"' + certPath + '"')
      // 并通过 Base64 EncodedCommand 执行，彻底免疫 cmd/shell 的转义和空格破坏
      const psScript = `Start-Process -FilePath 'certutil.exe' -ArgumentList @('-addstore', '-f', 'root', ('\"' + '${certPath.replace(/'/g, "''")}' + '\"')) -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop`;
      const b64 = Buffer.from(psScript, "utf16le").toString("base64");
      await execFileAsync("powershell.exe", ["-NoProfile", "-EncodedCommand", b64]);
      console.log("【成功】UAC 授权通过，证书已成功安装！");
      return true;
    } catch (e: any) {
      console.log("【失败】取消了 UAC 授权，或证书发生错误。", certPath, e.code);
    }
    return false;
  }
}

/**
 * 异步读取指定文件为 Buffer
 * 若文件不存在或读取失败，静默捕获异常并返回空 Buffer
 *
 * @param filePath 文件路径
 * @returns 包含文件内容的 Buffer
 */
async function readFile(filePath: string): Promise<Buffer> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (e: any) {
    return Buffer.alloc(0);
  }
}

/**
 * 从磁盘读取并验证私钥与证书的有效性
 *
 * 通过 Node.js 内置 crypto.X509Certificate 解析证书有效期：
 * - 检查证书是否尚未生效 (validFrom > now) 或已过期 (now >= validTo)；
 * - 只有在证书有效且私钥均存在时，才返回证书与私钥内容及过期时间。
 *
 * @param keyPath 私钥文件路径
 * @param certPath 证书文件路径
 * @returns 证书有效时返回 `{ key, cert, expiry }`，否则返回 null
 */
async function getCert(keyPath: string, certPath: string) {
  const [keyBuff, certBuff] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  let expiry = 0;
  if (keyBuff.length !== 0 && certBuff.length !== 0) {
    const x509 = new crypto.X509Certificate(certBuff);
    const validFrom = (x509.validFromDate || new Date(x509.validFrom)).getTime();
    const validTo = (x509.validToDate || new Date(x509.validTo)).getTime();
    const now = new Date().getTime();
    expiry = validFrom > now ? 0 : validTo;
  }

  return expiry > 0
    ? {
        key: String(keyBuff),
        cert: String(certBuff),
        expiry,
      }
    : null;
}

/**
 * 创建用于 TLS / HTTPS 服务的动态 SNI (Server Name Indication) 回调函数
 *
 * 功能机制：
 * 1. 动态按需签发：客户端建立 TLS 连接指定 servername 时，回调自动根据 CA 签发对应证书；
 * 2. 本地磁盘持久化：签发的证书写入磁盘缓存目录，避免重复生成开销；
 * 3. 内存 SecureContext 缓存：在内存中维护 SecureContext 映射，大幅提升 TLS 握手性能；
 * 4. LRU / FIFO 淘汰：缓存数量达到 maxHostCount 时自动淘汰最早建立的安全上下文；
 * 5. 防缓存击穿 (Pending Promise Map)：针对同一域名的并发请求进行合并，避免高并发下并发签发；
 * 6. CA 自动就绪：首次调用自动生成 10 年期根 CA 并尝试通过 trustCaInWindows 注册到系统受信任区。
 *
 * @param rootCaName 根 CA 名称，默认 "PG CA test"
 * @param maxHostCount 内存中最大缓存的 SecureContext 数量，默认 100
 * @param certDiskPath 证书本地磁盘持久化目录，默认为当前用户目录下的 AppData/Local/${rootCaName}
 * @returns 返回包含以下属性的对象：
 *   - `SNICallback`: 可直接用于 tls.createServer 或 https.createServer 的 SNICallback 函数
 *   - `installCA`: 确保根 CA 证书生成并安装到系统的初始化方法
 *   - `secureContextMap`: 内存中的 SecureContext 缓存映射
 */
export function createSNICallback(
  rootCaName = "PG CA test",
  maxHostCount = 100,
  certDiskPath = path.resolve(os.homedir(), "AppData", "Local", rootCaName),
  // log = console.log,
) {
  let caPem: Awaited<ReturnType<typeof getCert>> = null;
  let installCAPromise: Promise<void> | undefined;
  const secureContextMap = new Map<string, { ctx: tls.SecureContext; expiry: number }>();
  const secureContexPendingPromiseMap = new Map<string, Promise<void>>();

  /**
   * 异步创建指定域名的 SecureContext
   * 优先从磁盘加载，若无则使用 CA 动态签发并持久化到本地
   */
  const createSecureContext = async (servername: string) => {
    console.log("createSecureContext", servername);
    try {
      const certPath = path.resolve(certDiskPath, servername + ".crt");
      const keyPath = path.resolve(certDiskPath, servername + ".key");
      let pem = await getCert(keyPath, certPath);
      if (!pem) {
        if (!caPem) {
          await (installCAPromise || installCA());
          if (!caPem) throw new Error("CA key or cert is empty");
        }
        pem = await CertGenerator.createServerCert(servername, caPem.key, caPem.cert, 1);
        if (caPem.expiry > 0)
          await Promise.all([fs.promises.writeFile(certPath, pem.cert), fs.promises.writeFile(keyPath, pem.key)]);
      }

      const ctx = tls.createSecureContext({
        key: pem.key,
        cert: pem.cert,
      });
      if (secureContextMap.size >= maxHostCount) {
        /** 如果超过最大连接数，删除最早连接的 */
        console.log("删除最早连接的");
        secureContextMap.delete(secureContextMap.keys().next()?.value || "");
      }
      secureContextMap.set(servername, { ctx, expiry: pem.expiry });
    } finally {
      secureContexPendingPromiseMap.delete(servername);
    }
  };

  /**
   * SNI 握手回调函数
   * TLS 连接建立时触发，由客户端传入 servername 动态分发对应的 SecureContext
   */
  const SNICallback: NonNullable<tls.TlsOptions["SNICallback"]> = async (servername, callback) => {
    console.log("servername", servername);
    try {
      if (servername === "") throw new Error("servername is empty");
      if (/[\\/:*?"<>|]/.test(servername)) throw new Error("servername contain invalid char");
      let times = 3;
      do {
        const secureContext = secureContextMap.get(servername);
        if (secureContext) {
          if (secureContext.expiry > Date.now()) return callback(null, secureContext.ctx);
          console.log("证书过期");
          secureContextMap.delete(servername);
        }
        let pendingPromise = secureContexPendingPromiseMap.get(servername);
        if (pendingPromise) {
          await pendingPromise;
          continue;
        }
        pendingPromise = createSecureContext(servername);
        secureContexPendingPromiseMap.set(servername, pendingPromise);
        await pendingPromise;
      } while (times-- > 0);
      throw new Error("多次尝试创建安全上下文失败");
    } catch (e: any) {
      console.log("❌ SNICallback失败:", e);
      callback(e);
    }
  };

  /**
   * 初始化并安装 CA 根证书
   * 采用单例 Promise 保证并发安全
   */
  const installCA = () =>
    installCAPromise ||
    (installCAPromise = (async () => {
      console.log("installCA");
      try {
        const caKeyPath = path.resolve(certDiskPath, "ca.key");
        const caCertPath = path.resolve(certDiskPath, "ca.crt");
        caPem = await getCert(caKeyPath, caCertPath);
        if (caPem) return;
        let { caKeyPem, caCertPem, expiry } = await CertGenerator.createRootCA(rootCaName, 10);
        if (!caKeyPem || !caCertPem) throw new Error("自动生成CA证书失败");
        await fs.promises.mkdir(certDiskPath, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(caKeyPath + ".not.trusted", caKeyPem),
          fs.promises.writeFile(caCertPath, caCertPem),
        ]);
        if (await CertGenerator.trustCaInWindows(caCertPath)) {
          await fs.promises.rename(caKeyPath + ".not.trusted", caKeyPath);
        } else {
          console.log("CA证书安装失败，操作系统可能不信任该证书");
          expiry = 0;
        }
        caPem = {
          key: caKeyPem,
          cert: caCertPem,
          expiry,
        };
      } catch (e: any) {
        console.log("【失败】安装CA证书失败", e);
        installCAPromise = undefined;
        throw e;
      }
    })());

  return {
    SNICallback,
    installCA,
    secureContextMap,
  };
}

// 测试用例
// import * as https from "https";
/**
 * 以下测试用例涵盖 CertGenerator 与 createSNICallback 的典型使用场景：
 *
 * 测试用例 1: 手动生成 CA 根证书与服务器证书（支持多域名、泛域名、IP、中文国际化域名）并校验
 * 测试用例 2: 将 CA 根证书导入并信任到 Windows 系统受信任根证书库
 * 测试用例 3: 使用 createSNICallback 搭建动态自适应证书的 HTTPS 服务器
 *
 * 如需调试测试，可解除下方对应代码块的注释直接运行。
 */

/**
 * ----------------------------------------------------------------------------
 * 测试用例 1: 手动生成 CA 根证书并签发服务器证书
 * ----------------------------------------------------------------------------
 * 演示：
 * 1. 自动生成 10 年有效期的 RSA-2048 自签名 CA 根证书与私钥；
 * 2. 使用 CA 私钥签发服务器证书，涵盖主域名、通配符泛域名、IPv4、IPv6 及中文域名；
 * 3. 将证书写入本地文件并使用 Node.js crypto.X509Certificate 进行结构校验。
 */
// (async () => {
//   const rootCaName = "My Test CA";
//   console.log(`⏳ 正在生成 CA 根证书 (RSA-2048, 10年有效期, CN: ${rootCaName})...`);
//   const caContext = await CertGenerator.createRootCA(rootCaName, 10);
//   console.log("✅ CA 根证书生成成功！");
//
//   // 测试包含：主域名、泛域名、IPv4、IPv6、中文域名
//   const targetDomains = [
//     "hejianpeng.com",
//     "*.hejianpeng.com",
//     "127.0.0.1",
//     "::1",
//     "测试.cn",
//   ];
//
//   console.log(`⏳ 正在使用 CA 私钥签发服务器证书，包含域名/IP: ${targetDomains.join(", ")}...`);
//   const serverContext = await CertGenerator.createServerCert(
//     targetDomains,
//     caContext.caKeyObj,
//     caContext.caNameDer,
//     1, // 1 年有效期
//   );
//   console.log("✅ 服务器证书签发成功！");
//
//   // 保存为本地文件
//   await Promise.all([
//     fs.promises.writeFile("ca.key", caContext.caKeyPem),
//     fs.promises.writeFile("ca.crt", caContext.caCertPem),
//     fs.promises.writeFile("server.key", serverContext.key),
//     fs.promises.writeFile("server.crt", serverContext.cert),
//   ]);
//
//   console.log("\n✅ 成功！证书文件已写入本地磁盘：");
//   console.log("   📄 ca.key       (CA 根私钥)");
//   console.log("   📄 ca.crt       (CA 根证书)");
//   console.log("   📄 server.key   (服务器私钥)");
//   console.log("   📄 server.crt   (服务器证书链)");
//
//   // 解析并校验生成的证书内容
//   const x509 = new crypto.X509Certificate(serverContext.cert);
//   console.log("\n📋 证书校验信息：");
//   console.log("   - Subject (主题):", x509.subject);
//   console.log("   - Issuer (颁发者):", x509.issuer);
//   console.log("   - Valid From (生效时间):", x509.validFrom);
//   console.log("   - Valid To (到期时间):", x509.validTo);
//   console.log("   - SAN (主题备用名称):", x509.subjectAltName);
// })();

/**
 * ----------------------------------------------------------------------------
 * 测试用例 2: 将 CA 根证书导入并信任到 Windows 系统证书库
 * ----------------------------------------------------------------------------
 * 演示：
 * 调用 CertGenerator.trustCaInWindows 安装 CA 证书。
 * - 若已有管理员权限则静默安装；
 * - 若权限不足将自动弹出 Windows UAC 对话框请求管理员权限。
 */
// (async () => {
//   const caCertPath = path.resolve("./ca.crt");
//   console.log("⏳ 正在尝试将 CA 证书导入 Windows 受信任根证书库:", caCertPath);
//   const success = await CertGenerator.trustCaInWindows(caCertPath);
//   if (success) {
//     console.log("🎉 根证书已成功导入系统信任区！浏览器或系统应用访问由该 CA 签发的证书将不再提示安全警告。");
//   } else {
//     console.log("⚠️ 根证书导入未完成（用户取消了 UAC 授权或执行失败）。");
//   }
// })();

/**
 * ----------------------------------------------------------------------------
 * 测试用例 3: 使用 createSNICallback 搭建动态自适应证书的 HTTPS 服务器
 * ----------------------------------------------------------------------------
 * 演示：
 * 1. 初始化 createSNICallback 并自动安装/信任根 CA；
 * 2. 启动 HTTPS 服务，无论通过任何域名或 IP 访问，服务端均实时按需签发对应域名的证书并缓存；
 * 3. 内存与磁盘二级缓存，并发防击穿保护。
 */
// (async () => {
//   const { SNICallback, installCA } = createSNICallback("PG CA test");
//
//   // 确保 CA 根证书已创建并信任
//   console.log("⏳ 正在初始化 CA 根证书...");
//   await installCA();
//
//   // 创建 HTTPS 服务器并绑定 SNICallback
//   const server = https.createServer({ SNICallback }, (req, res) => {
//     res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
//     res.end(`<h1>HTTPS 服务运行正常！</h1><p>当前请求 Host: <b>${req.headers.host}</b></p>`);
//   });
//
//   const PORT = 443;
//   server.listen(PORT, () => {
//     console.log(`\n🚀 动态证书 HTTPS 服务器已启动: https://localhost:${PORT}`);
//     console.log(`   访问 https://127.0.0.1 或配置 hosts 访问任意域名测试 SNI 动态签发效果。`);
//   });
// })();
