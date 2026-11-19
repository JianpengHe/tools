/**
 * CertGenerator.ts - X.509 数字证书与 CRL 吊销列表生成工具
 *
 * 本模块基于 Node.js 原生 crypto 与 ASN1Encoder，实现了轻量级 X.509 证书体系的纯代码生成，
 * 不依赖 openssl 外部命令行程序即可纯代码生成符合 RFC 5280 规范的 X.509 v3 证书与 CRL。
 *
 * 核心功能：
 * 1. createRootCA: 生成自签名的 CA 根证书与私钥 (RSA-2048, SHA-256)
 * 2. createServerCert: 使用 CA 私钥签发服务器证书，支持单域名、泛域名 (*.xxx)、多域名、中文域名 (IDN / Punycode)、IPv4 与 IPv6
 * 3. createCRL: 生成符合 RFC 5280 v2 规范的空证书吊销列表 (CRL)
 */

import * as crypto from "crypto";
import * as net from "net";
import * as url from "url";
import { ASN1Encoder } from "./ASN1Encoder";

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
 * 证书与 CRL 生成逻辑核心
 * ============================================================================
 * 包含 CA 根证书生成、服务器证书签发以及 CRL 吊销列表生成功能。
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
    /** 标准扩展: Authority Information Access / 颁发机构信息访问 (1.3.6.1.5.5.7.1.1 / id-pe-authorityInfoAccess) */
    AIA: Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01]),
    /** AIA 访问方法: OCSP (1.3.6.1.5.5.7.48.1 / id-ad-ocsp) */
    AD_OCSP: Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01]),
    /** 标准扩展: CRL Distribution Points / CRL 分发点 (2.5.29.31 / id-ce-cRLDistributionPoints) */
    CDP: Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1f]),
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
   * 6. 有效期: notBefore 为当前时间倒退 10 分钟 (防时钟漂移)，notAfter 必须大于 notBefore
   *
   * @param commonName CA 根证书的主体名称 (Common Name)，例如 "My Root CA"
   * @param expiryTime 证书到期毫秒时间戳，不传则默认为当前时间起 20 年
   * @returns 返回生成的 CA 密钥及证书对象：
   *   - `caKeyObj`: 内存中的 KeyObject 私钥对象，用于后续直接为服务端证书签名
   *   - `caNameDer`: CA 主体名称的 ASN.1 DER 编码 Buffer，签发服务端证书时作为 Issuer
   *   - `caKeyPem`: PKCS#8 格式的私钥 PEM 字符串
   *   - `caCertPem`: X.509 格式的根证书 PEM 字符串
   *   - `expiry`: 证书过期时间戳（毫秒）
   */
  public static async createRootCA(commonName: string, expiryTime?: number) {
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

    // 生效时间：向前偏移 10 分钟防止客户端时钟漂移
    const notBefore = new Date(Date.now() - 10 * 60 * 1000);
    // 到期时间：默认 20 年
    const notAfter =
      expiryTime !== undefined ? new Date(expiryTime) : new Date(notBefore.getTime() + 20 * 365 * 86400_000);
    if (notAfter.getTime() <= notBefore.getTime()) {
      throw new Error(
        `Invalid certificate validity: notAfter (${notAfter.toISOString()}) must be later than notBefore (${notBefore.toISOString()})`,
      );
    }
    const validity = ASN1Encoder.sequence(ASN1Encoder.utcTime(notBefore), ASN1Encoder.utcTime(notAfter));

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
      expiry: notAfter.getTime(),
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
   * @param expiryTime 服务器证书到期毫秒时间戳，不传则默认为当前时间起 1 年
   * @param crlUrl CRL 分发点 URL（如 "http://127.0.0.1:8919/ca.crl"），为空则不添加 CDP 扩展
   * @returns 返回包含服务器私钥及完整证书链的对象：
   *   - `key`: PKCS#8 格式的服务器私钥 PEM 字符串
   *   - `cert`: 完整的证书链 PEM 字符串 (服务器证书 + CA 证书)
   *   - `expiry`: 证书过期时间戳（毫秒）
   */
  public static async createServerCert(
    domain: string | string[],
    caKey: crypto.KeyObject | string | Buffer,
    caCertOrNameDer: Buffer | string,
    expiryTime?: number,
    crlUrl?: string,
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

    // 生效时间：向前偏移 10 分钟防止客户端时钟漂移
    const notBefore = new Date(Date.now() - 10 * 60 * 1000);
    // 到期时间：默认 1 年
    const notAfter = expiryTime !== undefined ? new Date(expiryTime) : new Date(notBefore.getTime() + 365 * 86400_000);
    if (notAfter.getTime() <= notBefore.getTime()) {
      throw new Error(
        `Invalid certificate validity: notAfter (${notAfter.toISOString()}) must be later than notBefore (${notBefore.toISOString()})`,
      );
    }
    const validity = ASN1Encoder.sequence(ASN1Encoder.utcTime(notBefore), ASN1Encoder.utcTime(notAfter));

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

    // - CDP: CRL Distribution Points（若提供了 crlUrl，写入 CRL 分发点地址供客户端查询吊销状态）
    const extList = [bcExt, serverKuExt, sanExt, ekuExt];
    if (crlUrl) {
      const crlUrlBuf = Buffer.from(crlUrl, "ascii");
      // uniformResourceIdentifier [6] IMPLICIT (0x86)
      const uri = Buffer.concat([Buffer.from([0x86]), ASN1Encoder.encodeLength(crlUrlBuf.length), crlUrlBuf]);
      // DistributionPointName.fullName [0] CONSTRUCTED (0xa0)
      const fullName = Buffer.concat([Buffer.from([0xa0]), ASN1Encoder.encodeLength(uri.length), uri]);
      // DistributionPoint.distributionPoint [0] CONSTRUCTED (0xa0)
      const dp = Buffer.concat([Buffer.from([0xa0]), ASN1Encoder.encodeLength(fullName.length), fullName]);
      const cdpExt = ASN1Encoder.sequence(
        this.OID.CDP,
        ASN1Encoder.octetString(ASN1Encoder.sequence(ASN1Encoder.sequence(dp))),
      );
      extList.push(cdpExt);
    }

    const extensions = ASN1Encoder.sequence(...extList);
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
      expiry: notAfter.getTime(),
    };
  }

  /**
   * 生成空的 CRL (Certificate Revocation List) 证书吊销列表
   *
   * 构造规范 (符合 RFC 5280 Section 5)：
   * 1. 版本: v2 (INTEGER 1)
   * 2. 签名算法: SHA-256 with RSA
   * 3. 颁发者: 与 CA 证书的 Subject 完全一致
   * 4. thisUpdate: 当前时间倒退 10 分钟 (防时钟漂移)
   * 5. nextUpdate: 吊销列表下一次更新的到期时间戳，必须大于 thisUpdate
   * 6. revokedCertificates: 省略（表示没有被吊销的证书）
   *
   * @param caKey CA 私钥 KeyObject，用于签名 CRL
   * @param caNameDer CA Subject Name 的 ASN.1 DER 编码 Buffer
   * @param expiryTime CRL 下次更新毫秒时间戳（通常对齐 CA 根证书的 expiry）
   * @returns DER 编码的 CRL Buffer，可通过 ASN1Encoder.toPem("X509 CRL", ...) 转为 PEM
   */
  public static createCRL(caKey: crypto.KeyObject, caNameDer: Buffer, expiryTime: number): Buffer {
    const sigAlg = ASN1Encoder.sequence(this.OID.SHA256_RSA, Buffer.from([0x05, 0x00]));
    const thisUpdate = new Date(Date.now() - 10 * 60 * 1000);
    const nextUpdate = new Date(expiryTime);
    if (nextUpdate.getTime() <= thisUpdate.getTime()) {
      throw new Error(
        `Invalid CRL validity: nextUpdate (${nextUpdate.toISOString()}) must be later than thisUpdate (${thisUpdate.toISOString()})`,
      );
    }
    // TBSCertList: version(v2=1), sigAlg, issuer, thisUpdate, nextUpdate
    // 无 revokedCertificates 字段（空列表 = 未吊销任何证书）
    const tbsCertList = ASN1Encoder.sequence(
      ASN1Encoder.integer(Buffer.from([0x01])),
      sigAlg,
      caNameDer,
      ASN1Encoder.utcTime(thisUpdate),
      ASN1Encoder.utcTime(nextUpdate),
    );
    const signature = crypto.sign("sha256", tbsCertList, caKey);
    return ASN1Encoder.sequence(tbsCertList, sigAlg, ASN1Encoder.bitString(signature));
  }
}

// ============================================================================
// 测试用例 / 使用示例: 手动生成 CA 根证书、CRL 吊销列表并签发服务器证书
// ============================================================================
/**
 * 演示：
 * 1. 自动生成默认 20 年有效期的 RSA-2048 自签名 CA 根证书与私钥；
 * 2. 使用 CA 私钥签发空 CRL (Certificate Revocation List)，有效期对齐 CA；
 * 3. 使用 CA 私钥签发服务器证书（默认 1 年），涵盖主域名、通配符泛域名、IPv4、IPv6、中文域名，并植入 CRL 分发点 URL；
 * 4. 将生成的证书和私钥写入本地文件，并使用 Node.js 原生 crypto.X509Certificate 进行结构校验与属性打印。
 *
 * 如需调试测试，可解除下方对应代码块的注释直接运行。
 */
// (async () => {
//   const fs = await import("fs");
//   const path = await import("path");
//
//   const rootCaName = "My Test CA";
//   const crlUrl = "http://127.0.0.1:8919/ca.crl";
//   console.log(`⏳ 正在生成 CA 根证书 (RSA-2048, 默认 20 年, CN: ${rootCaName})...`);
//   const caContext = await CertGenerator.createRootCA(rootCaName);
//   console.log("✅ CA 根证书生成成功！到期时间:", new Date(caContext.expiry).toISOString());
//
//   console.log("⏳ 正在生成 CRL 吊销列表 (有效期对齐 CA)...");
//   const crlDer = CertGenerator.createCRL(caContext.caKeyObj, caContext.caNameDer, caContext.expiry);
//   console.log("✅ CRL 吊销列表生成成功！");
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
//   console.log(`⏳ 正在使用 CA 私钥签发服务器证书 (默认 1 年)，包含域名/IP: ${targetDomains.join(", ")}，CRL: ${crlUrl}...`);
//   const serverContext = await CertGenerator.createServerCert(
//     targetDomains,
//     caContext.caKeyObj,
//     caContext.caNameDer,
//     undefined, // 默认 1 年
//     crlUrl,
//   );
//   console.log("✅ 服务器证书签发成功！到期时间:", new Date(serverContext.expiry).toISOString());
//
//   // 保存为本地文件示例
//   await Promise.all([
//     fs.promises.writeFile(path.resolve("./ca.key"), caContext.caKeyPem),
//     fs.promises.writeFile(path.resolve("./ca.crt"), caContext.caCertPem),
//     fs.promises.writeFile(path.resolve("./ca.crl"), crlDer),
//     fs.promises.writeFile(path.resolve("./server.key"), serverContext.key),
//     fs.promises.writeFile(path.resolve("./server.crt"), serverContext.cert),
//   ]);
//
//   console.log("\n✅ 成功！证书文件已写入本地磁盘：");
//   console.log("   📄 ca.key       (CA 根私钥)");
//   console.log("   📄 ca.crt       (CA 根证书)");
//   console.log("   📄 ca.crl       (CA 吊销列表 DER)");
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
