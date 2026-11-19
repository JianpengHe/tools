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
 * 6. CA 自动就绪：首次调用自动生成根 CA 并通过 trustCaInWindows 注册到系统受信任根证书库；
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
import { trustCaInWindows } from "./systemCert";

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
 * @param opt 配置选项
 * @param opt.rootCaName 根 CA 名称，默认 "PG CA test"
 * @param opt.maxHostCount 内存中最大缓存的 SecureContext 数量，默认 100
 * @param opt.certDiskPath 证书本地磁盘持久化目录，默认为当前用户目录下的 AppData/Local/${rootCaName}
 * @param opt.crlUrl CRL 分发点 HTTP URL（如 "http://127.0.0.1:8919/ca.crl"），为空则不启用 CRL 功能
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
  } = {},
) {
  const {
    rootCaName = "PG CA test",
    maxHostCount = 100,
    certDiskPath = path.resolve(os.homedir(), "AppData", "Local", opt.rootCaName || "PG CA test"),
    crlUrl,
  } = opt;
  let caPem: (NonNullable<Awaited<ReturnType<typeof getCert>>> & { crlDer?: Buffer }) | null = null;
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
        pem = await CertGenerator.createServerCert(servername, caPem.key, caPem.cert, undefined, crlUrl);
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
        let { caKeyPem, caCertPem, expiry } = await CertGenerator.createRootCA(rootCaName);
        if (!caKeyPem || !caCertPem) throw new Error("自动生成CA证书失败");
        await fs.promises.mkdir(certDiskPath, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(caKeyPath + ".not.trusted", caKeyPem),
          fs.promises.writeFile(caCertPath, caCertPem),
        ]);
        if (await trustCaInWindows(caCertPath)) {
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
 * 1. 初始化 createSNICallback 并配置根 CA 名称与 CRL 分发点地址；
 * 2. 自动生成并信任根 CA（首次运行自动触发系统安装）；
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
//   const CRL_PORT = 8919;
//   const crlUrl = `http://127.0.0.1:${CRL_PORT}/ca.crl`;
//
//   const { SNICallback, installCA, handleCRL } = createSNICallback({
//     rootCaName: "PG CA test",
//     crlUrl,
//   });
//
//   // 1. 初始化并确保 CA 根证书就绪（若未信任将触发系统导入）
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
