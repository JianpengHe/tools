/**
 * CertManager.ts - 动态 SNI 证书管理与 TLS 安全上下文运行时
 *
 * 本模块为 HTTPS / TLS 服务器提供动态 SNI (Server Name Indication) 支持，
 * 在接收到客户端 TLS 握手时，根据 SNI 域名动态使用根 CA 签发服务端证书并建立安全上下文。
 *
 * 核心机制：
 * 1. 动态按需签发：客户端建立 TLS 连接指定 servername 时，回调自动根据 CA 签发对应证书；
 * 2. 本地磁盘持久化：签发的证书写入磁盘缓存目录，避免重复生成开销；
 * 3. 内存 SecureContext 缓存：在内存中维护 SecureContext 映射，大幅提升 TLS 握手性能；
 * 4. LRU / FIFO 淘汰：缓存数量达到 maxHostCount 时自动淘汰最早建立的安全上下文；
 * 5. 防缓存击穿 (Pending Promise Map)：针对同一域名的并发请求进行合并，避免高并发下重复签发；
 * 6. CA 自动就绪与信任检测：首次调用自动生成根 CA，通过 isCaTrustedByOS 检测系统信任状态，并可通过注入的 trustCa 导入系统受信任根证书库；
 * 7. CRL 吊销列表：当配置 crlUrl 时，自动生成空 CRL 文件并提供 handleCRL 方法响应 HTTP 请求。
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tls from "tls";
import * as http from "http";
import { ASN1Encoder } from "./ASN1Encoder";
import { CertGenerator } from "./CertGenerator";
import { MapProCustomTtl } from "../util/MapProCustomTtl";

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
    expiry = validFrom > now || validTo <= now ? 0 : validTo;
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
 * 检查当前操作系统是否已信任指定的 CA 证书
 *
 * 基于 Node.js 内置的 `tls.getCACertificates("system")` 读取操作系统信任根证书列表，
 * 并与目标 CA 证书逐一比对原始 DER 二进制内容（X.509 raw Buffer）。
 *
 * @param targetCaPem 待检查的目标 CA 证书（PEM 格式字符串）
 * @returns
 *   - `true`: 操作系统已信任该证书；
 *   - `false`: 当前 Node.js 支持系统证书库读取，且该证书未被信任；
 *   - `null`: 当前 Node.js 运行时不支持 `tls.getCACertificates`（低于 Node.js 22.3.0）或证书内容无效。
 */
export function isCaTrustedByOS(targetCaPem: string): boolean | null {
  try {
    // 解析目标 CA 证书，提取原始 DER 二进制内容 (Buffer)
    const targetRaw = new crypto.X509Certificate(targetCaPem).raw;

    // 遍历并直接比对二进制内容
    return (
      tls.getCACertificates?.("system")?.some(pem => {
        try {
          return new crypto.X509Certificate(pem).raw.equals(targetRaw);
        } catch {
          return false;
        }
      }) ?? null
    );
  } catch (e) {
    console.error("检查CA是否信任失败:", e);
    return null;
  }
}

/**
 * 创建用于 TLS / HTTPS 服务的动态 SNI (Server Name Indication) 回调函数
 *
 * @param opt 配置选项
 * @param opt.rootCaName 根 CA 名称，默认 "PG CA test"
 * @param opt.maxHostCount 内存中最大缓存的 SecureContext 数量，默认 100
 * @param opt.certDiskPath 证书本地磁盘持久化目录，默认为当前用户目录下的 AppData/Local/${rootCaName}
 * @param opt.crlUrl CRL 分发点 HTTP URL（如 "http://127.0.0.1:8919/ca.crl"），为空则不启用 CRL 功能
 * @param opt.trustCa 自定义 CA 根证书系统信任安装函数（例如接入 systemCert.ts 的 trustCa 实现）
 * @returns 返回包含以下属性的对象：
 *   - `SNICallback`: 可直接用于 tls.createServer 或 https.createServer 的 SNICallback 函数
 *   - `installCA`: 确保根 CA 证书生成并安装到系统的初始化方法
 *   - `secureContextMap`: 内存中的 SecureContext 缓存映射
 *   - `handleCRL`: 处理 CRL HTTP 请求的异步方法（仅当配置了 crlUrl 时有效）
 */
export function createSNICallback(
  opt: {
    rootCaName?: string;
    maxHostCount?: number;
    certDiskPath?: string;
    crlUrl?: string;
    trustCa?: (caPath: string) => Promise<boolean>;
  } = {},
) {
  const {
    rootCaName = "PG CA test",
    maxHostCount = 100,
    certDiskPath = path.resolve(os.homedir(), "AppData", "Local", opt.rootCaName || "PG CA test"),
    crlUrl,
    trustCa = async path => Boolean(console.log(`请传入trustCa函数或手动信任${path}的CA根证书`)),
  } = opt;
  let caPem: (NonNullable<Awaited<ReturnType<typeof getCert>>> & { crlDer?: Buffer }) | null = null;
  let installCAPromise: Promise<void> | undefined;

  /**
   * 基于 MapPro 维护 SecureContext 内存缓存：
   * - LRU 淘汰：达到 maxHostCount 时自动淘汰最久未访问的上下文
   * - 自动 Singleflight：同一域名的并发请求自动去重，避免重复签发
   */
  const secureContextMap = new MapProCustomTtl<string, tls.SecureContext>({
    cacheSize: maxHostCount,
    init: async (servername, setTtl) => {
      console.log("createSecureContext", servername);
      const certPath = path.resolve(certDiskPath, servername + ".crt");
      const keyPath = path.resolve(certDiskPath, servername + ".key");
      let pem = await getCert(keyPath, certPath);
      if (!pem) {
        if (!caPem) {
          await (installCAPromise || installCA());
          if (!caPem) throw new Error("CA key or cert is empty");
        }
        pem = await CertGenerator.createServerCert(servername, caPem.key, caPem.cert, undefined, crlUrl);
        if (caPem.expiry > 0)
          await Promise.all([fs.promises.writeFile(certPath, pem.cert), fs.promises.writeFile(keyPath, pem.key)]);
      }

      // 证书到期自动淘汰，最小有效期 10 秒
      setTtl(Math.max(pem.expiry - Date.now(), 10_000));
      return tls.createSecureContext({
        key: pem.key,
        cert: pem.cert,
      });
    },
  });

  /**
   * SNI 握手回调函数
   * TLS 连接建立时触发，由客户端传入 servername 动态分发对应的 SecureContext
   */
  const SNICallback: NonNullable<tls.TlsOptions["SNICallback"]> = async (servername, callback) => {
    console.log("servername", servername);
    try {
      if (servername === "") throw new Error("servername is empty");
      if (/[\\/:*?"<>|]/.test(servername)) throw new Error("servername contain invalid char");

      const ctx = await secureContextMap.getAsync(servername);
      if (!ctx) throw new Error("创建安全上下文失败");
      callback(null, ctx);
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
        if (caPem) {
          if (isCaTrustedByOS(caPem.cert) === false) await trustCa(caCertPath);
          return;
        }
        let { caKeyPem, caCertPem, expiry } = await CertGenerator.createRootCA(rootCaName);
        if (!caKeyPem || !caCertPem) throw new Error("自动生成CA证书失败");
        await fs.promises.mkdir(certDiskPath, { recursive: true });
        await Promise.all([fs.promises.writeFile(caKeyPath, caKeyPem), fs.promises.writeFile(caCertPath, caCertPem)]);
        await trustCa(caCertPath);
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

  /**
   * 处理 CRL HTTP 请求
   * 将缓存的 CRL DER 字节以 application/pkix-crl 格式写入 HTTP 响应
   *
   * @param req HTTP 请求对象（IncomingMessage）
   * @param res HTTP 响应对象（ServerResponse）
   * @returns true 表示成功响应了 CRL，false 表示 CRL 未就绪或未启用
   */
  const handleCRL = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    if (!crlUrl) return false;
    await (installCAPromise || installCA());
    if (!caPem || caPem.expiry <= Date.now()) return false;
    // 惰性计算：需要时算一次并缓存到 caPem 对象中，有效期与 CA 根证书完全一致
    if (!caPem.crlDer) {
      const caKeyObj = crypto.createPrivateKey(caPem.key);
      const caNameDer = ASN1Encoder.extractSubject(caPem.cert);
      caPem.crlDer = CertGenerator.createCRL(caKeyObj, caNameDer, caPem.expiry);
    }
    res.writeHead(200, {
      "Content-Type": "application/pkix-crl",
      "Content-Length": caPem.crlDer.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(caPem.crlDer);
    return true;
  };

  return {
    SNICallback,
    installCA,
    secureContextMap,
    handleCRL,
  };
}

// ============================================================================
// 测试用例 / 使用示例: 搭建动态证书 HTTPS 服务器与 CRL HTTP 响应服务
// ============================================================================
/**
 * 演示：
 * 1. 结合 systemCert 的 trustCa 初始化 createSNICallback，配置根 CA 名称与 CRL 分发点；
 * 2. 自动检测系统是否已信任根 CA（基于 isCaTrustedByOS），并在未信任时自动触发系统静默/提权安装；
 * 3. 启动同机 HTTP 基础服务，通过 handleCRL 响应 CRL 吊销请求；
 * 4. 启动 HTTPS 服务并绑定 SNICallback：
 *    - 任意域名访问（如 https://localhost:443、https://127.0.0.1:443 或 hosts 自定义域名）；
 *    - 服务端均能毫秒级动态签发对应域名的 X.509 证书并存入内存与磁盘缓存；
 *    - 解决 Windows SChannel 与严格客户端的吊销校验告警。
 *
 * 如需调试测试，可解除下方对应代码块的注释直接运行。
 */
// (async () => {
//   const https = await import("https");
//   const { trustCa } = await import("./systemCert");
//   const CRL_PORT = 8919;
//   const crlUrl = `http://127.0.0.1:${CRL_PORT}/ca.crl`;
//
//   const { SNICallback, installCA, handleCRL } = createSNICallback({
//     rootCaName: "PG CA test",
//     crlUrl,
//     trustCa, // 注入系统根证书安装函数 (支持 Windows certutil / UAC 自提权)
//   });
//
//   // 1. 初始化并确保 CA 根证书就绪（内部通过 isCaTrustedByOS 自动检测，未信任时才调用 trustCa）
//   console.log("⏳ 正在初始化 CA 根证书与 CRL...");
//   await installCA();
//
//   // 2. 启动 HTTP 吊销列表服务 (响应客户端的 CRL 查询请求)
//   const crlServer = http.createServer(async (req, res) => {
//     if (req.url === "/ca.crl" && (await handleCRL(req, res))) return;
//     res.writeHead(404);
//     res.end("Not Found");
//   });
//   crlServer.listen(CRL_PORT, "127.0.0.1", () => {
//     console.log(`📡 CRL 吊销查询 HTTP 服务已就绪: ${crlUrl}`);
//   });
//
//   // 3. 创建 HTTPS 服务器并绑定 SNICallback 实现动态签发
//   const server = https.createServer({ SNICallback }, (req, res) => {
//     res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
//     res.end(`<h1>HTTPS 动态自签服务运行正常！</h1><p>当前请求 Host: <b>${req.headers.host}</b></p>`);
//   });
//
//   const PORT = 443;
//   server.listen(PORT, () => {
//     console.log(`\n🚀 动态证书 HTTPS 服务器已启动: https://localhost:${PORT}`);
//     console.log(`   访问示例:`);
//     console.log(`   - 浏览器打开: https://localhost`);
//     console.log(`   - curl 命令测试: curl -I https://localhost`);
//     console.log(`   - 任意域名测试: 在 hosts 中将 test.local 指向 127.0.0.1，然后访问 https://test.local`);
//   });
// })();
