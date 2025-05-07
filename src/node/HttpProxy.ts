/**
 * HttpProxy.ts
 *
 * 这个文件实现了一个高级HTTP代理服务器，支持以下功能：
 * 1. 支持HTTP和HTTPS协议的代理
 * 2. 支持请求和响应的拦截与修改
 * 3. 支持系统代理设置的自动配置
 * 4. 支持PAC脚本模式和普通代理模式
 * 5. 支持DNS代理模式，可以实现更精细的域名控制
 * 6. 支持动态添加需要代理的域名
 */

import * as net from "net";
import * as tls from "tls";
import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import * as dns from "dns";
import * as crypto from "crypto";
import { TcpProxy } from "./TcpProxy";
import { recvAll } from "./utils";
import {
  EOperatingSystemHttpProxyStatus,
  getProcessNameByPort,
  OperatingSystemHttpProxy,
} from "./systemNetworkSettings";
import { DnsServer, EDnsResolveType } from "./dnsService";

/** 客户端（浏览器）发送的请求，还没有到达目标服务器前 */
export type IHttpProxyReq = {
  /** 模式，常见是GET、POST */
  method: string;
  /** url */
  url: URL;
  /** 请求头 */
  headers: http.IncomingHttpHeaders;
  /** 请求的正文部分 */
  body?: Buffer;
};

/** 目标服务器的响应，还没有到达客户端（浏览器）之前 */
export type IHttpProxyRes = {
  /** 状态码，常见是200、404 */
  code: number;
  /** 响应头 */
  headers: http.IncomingHttpHeaders;
  /** 响应的正文部分 */
  body?: Buffer | string;
};

/** 根据代理规则匹配成功后，处理和篡改请求或响应的回调函数 */
export type IHttpProxyFn = (
  localReq: IHttpProxyReq,
) => AsyncGenerator<Partial<IHttpProxyReq> | null | undefined, Partial<IHttpProxyRes> | undefined, IHttpProxyRes>;

/** 代理规则，返回一个布尔值代表这个请求是否需要拦截 */
export type IHttpProxyRegFn = (method: string, url: URL, headers: http.IncomingHttpHeaders) => boolean;

/**
 * HTTP代理服务器的配置选项
 */
export type IHttpProxyOpt = {
  /** 接受DnsServer对象、host文件地址，不传默认httpProxy模式 */
  proxyMode?: TcpProxy["dnsMode"]; // undefined

  /** dnsMode为httpProxy时，代表【代理服务器】的地址，当dnsMode为DnsServer对象时，代表【中转服务器】地址（而不是使用127.xx.xx.xx，方便其他终端调试） */
  proxyBindIp?: string; // "127.0.0.1"

  /** 同上，代理服务器或中转服务器的端口 */
  proxyBindPort?: number; // 1080

  /** 需要本代理支持哪些目标网站的端口，httpProxy模式下忽略该参数 */
  listenRequestPorts?: number[]; // [80,443]

  /** 代理规则表，addProxyRule的批量版本，一般情况下不需要填 */
  routeMap?: Map<IHttpProxyRegFn, IHttpProxyFn>;

  /** 是否自动完成系统设置 */
  autoSettings?: boolean; // true

  /** 是否显示应用名称，有轻微性能损耗 */
  showProcessName?: boolean; // true

  /** 是否需要代理该域名（beta，只支持系统代理和DNS代理） */
  onNewHost?: (host: string) => Promise<boolean>; // undefined

  /** 关闭回环检测（不再添加pg_no_loop_token请求头，可能会导致代理自己请求自己的死循环） */
  disabledLoopCheck?: boolean; // false

  /** 是否在https模式下仅代理名单（包括onNewHost添加的域名）中的域名，提高性能 */
  onlyProxyHostInList?: boolean; // false

  /** 本代理对外的请求是否使用系统设置的代理。在DnsServer模式下会有一点小问题，正在解决 */
  useSystemProxy?: boolean; // false

  /** 禁用一般的日志输出控制台 */
  disableLog?: boolean; // false
};

/**
 * 从主机字符串中提取主机名和端口号
 * @param rawHost 原始主机字符串，格式为"主机名:端口号"
 * @returns 返回一个包含主机名和端口号的元组
 */
const getHostPort = (rawHost: string): [string, number] => {
  const [_, host, port] = (rawHost || "").match(/^(.+):(\d+)$/) || [];
  return [host, Number(port || 0)];
};

/**
 * HTTP代理服务器类
 *
 * 该类实现了一个高级HTTP代理服务器，支持HTTP和HTTPS协议的代理，
 * 支持请求和响应的拦截与修改，支持系统代理设置的自动配置，
 * 支持PAC脚本模式和普通代理模式，支持DNS代理模式，可以实现更精细的域名控制，
 * 支持动态添加需要代理的域名。
 */
export class HttpProxy {
  /**
   * 使用PG的公共证书签发平台或自定义ssl证书
   * 用于获取HTTPS代理所需的SSL证书
   */
  private readonly certificateCenter: URL | ((host: string) => Promise<tls.SecureContextOptions>);

  /**
   * 获取SSL证书
   * 从证书中心获取指定域名的SSL证书，用于HTTPS代理
   * @param host 需要获取证书的域名
   * @returns 返回一个Promise，解析为tls.SecureContext对象
   */
  private readonly createSecureContext = async (host: string): Promise<tls.SecureContext> => {
    const { certificateCenter } = this;
    if (typeof certificateCenter === "function") return tls.createSecureContext(await certificateCenter(host));
    return new Promise((resolve, reject) =>
      (certificateCenter.protocol === "https:" ? https : http)
        .get(`${certificateCenter}${host}`, async res => {
          res.once("error", reject);
          try {
            resolve(tls.createSecureContext(JSON.parse(String(await recvAll(res)))));
          } catch (e) {
            reject(e);
          }
        })
        .once("error", reject),
    );
  };

  /**
   * 需要代理哪些域名
   * 存储所有需要被代理的域名列表
   */
  private readonly hosts: string[];

  /**
   * 这些域名对应的初始IP
   * 存储域名到其原始IP地址的映射关系，用于恢复原始连接
   */
  private readonly hostsOriginalIpMap: Map<string, string> = new Map();

  /**
   * 唯一标志
   * 生成一个随机的标识符，用于防止代理循环和标识PAC脚本
   */
  public readonly token = (o => {
    while (o.length < 40) {
      o += Math.random().toString(36).substring(2);
    }
    return o;
  })("");

  /**
   * 代理规则哈希表
   * 存储所有注册的代理规则和对应的处理函数
   */
  public readonly routeMap: Map<IHttpProxyRegFn, IHttpProxyFn>;

  /**
   * 对外请求的代理服务器配置
   * 存储HttpProxy的所有配置选项
   */
  private readonly opt: IHttpProxyOpt;

  /**
   * 当遇到新域名时的处理函数
   * 将新域名添加到代理列表，并解析其IP地址
   * @param hostname 新的域名
   */
  private async onNewHost(hostname: string) {
    this.hosts.push(hostname);
    try {
      this.hostsOriginalIpMap.set(
        hostname,
        net.isIPv4(hostname) ? hostname : (await dns.promises.resolve4(hostname))[0] || "",
      );
    } catch (e) {
      console.log("添加失败", hostname, e);
    }
  }

  /**
   * 本地代理服务器
   * 创建一个HTTP服务器作为代理服务器，处理所有的HTTP请求
   */
  public readonly proxyServer: net.Server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // console.log(req.url);
      /**
       * 检查连接是否为加密连接（HTTPS）
       * encrypted属性表示该连接是否为TLS加密连接
       */
      const encrypted = req.socket["encrypt" + "ed"];

      /**
       * 处理PAC脚本请求
       * 当客户端请求PAC脚本配置时，返回一个JavaScript函数，该函数告诉浏览器哪些域名需要通过代理访问
       */
      if (!encrypted && req.url === `/pg_pac_script_config/${this.token}`) {
        this.opt.disableLog ||
          console.log(
            "读取PAC脚本",
            this.opt.showProcessName ? await getProcessNameByPort(req.socket.remotePort, req.socket.localPort) : "",
          );
        res.end(`function FindProxyForURL(url, host) {
        if (${
          /** 如果存在onNewHost，就说明需要动态添加域名，因此无法使用PAC脚本 */
          this.opt.onNewHost ? "1" : this.hosts.map(host => `dnsDomainIs(host, "${host}")`).join("||") || "1"
        }) {
          return "PROXY ${this.opt.proxyBindIp}:${this.opt.proxyBindPort}; DIRECT";
        } else {
          return "DIRECT";
        }
      }`);
        return;
      }

      /**
       * 如果请求没有host头或URL，返回404错误
       */
      if (!req?.headers?.host || !req.url) {
        res.statusCode = 404;
        res.end("404");
        return;
      }

      /**
       * 防止代理循环
       * 通过添加特殊的请求头标记来检测并防止代理循环（代理自己请求自己）
       */
      /** 判断回环的几种方法，但还没定下来最好的方法。。。 */
      if (!this.opt.disabledLoopCheck) {
        if (req.headers["pg_no_loop_token"] === this.token) {
          res.end("loop");
          return;
        }
        req.headers["pg_no_loop_token"] = this.token;
      }
      // if (!encrypted && req.url[0] === "/") {
      //   res.statusCode = 403;
      //   res.end("proxyServer");
      //   return;
      // }

      /**
       * 构建完整的URL对象
       * 根据请求的协议和主机头，构建完整的URL对象
       */
      const url = new URL(req.url[0] === "/" ? `http${encrypted ? "s" : ""}://${req.headers.host}${req.url}` : req.url);
      // if (url.protocol === "http:") {
      //   url.port = url.port || "80";
      //   if (url.port === "1080") {
      //     const hosts: string[] = net.isIPv4(url.hostname)
      //       ? [url.hostname]
      //       : await new Promise(r => {
      //           dns.resolve4(url.hostname, (err, ad) => r(ad || []));
      //         });
      //     if (hosts.includes("127.0.0.1")) {
      //       res.end("loop");
      //       return;
      //     }
      //     console.log(hosts);
      //   }
      // }
      /** 判断回环END */

      /**
       * 创建代理请求对象
       * 将客户端的请求转换为代理请求对象，供后续处理
       */
      /** 浏览器到代理服务器的req句柄，交由开发者修改后，使用该req句柄请求远端服务器 */
      const httpProxyReq: IHttpProxyReq = {
        method: req.method?.toUpperCase() || "GET",
        url,
        headers: req.headers,
      };

      /**
       * 查找匹配的代理规则
       * 初始化代理函数变量，用于后续处理请求和响应
       */
      /** 开发者修改请求的函数 */
      let httpProxyFn: ReturnType<IHttpProxyFn> | undefined = undefined;
      const { proxyMode, onNewHost, proxyBindIp } = this.opt;

      /**
       * 动态添加新域名
       * 如果启用了onNewHost功能，并且请求的域名不是代理服务器本身，则尝试添加新域名
       */
      if (
        !encrypted &&
        onNewHost &&
        proxyMode === undefined &&
        url.hostname !== proxyBindIp &&
        (await onNewHost(url.hostname))
      ) {
        await this.onNewHost(url.hostname);
      }

      /**
       * 查找匹配的代理规则
       * 如果域名在hosts列表中，遍历所有代理规则，找到第一个匹配的规则，才交给开发者处理
       */
      if (this.hosts.includes(url.hostname)) {
        for (const [regFn, fn] of this.routeMap) {
          /**看满足哪条"代理规则" */
          if (regFn(httpProxyReq.method, url, httpProxyReq.headers)) {
            httpProxyReq.body = await recvAll(req);
            httpProxyReq.headers["accept-encoding"] = "gzip";
            httpProxyFn = fn(httpProxyReq);
            break;
          }
        }
      }

      /**
       * 设置请求头中的host字段
       * 将请求头中的host字段设置为目标URL的host
       */
      httpProxyReq.headers.host = url.host;

      /**
       * 解析域名为IP地址
       * 将URL中的域名替换为其对应的IP地址（如果存在映射）
       */
      url.hostname = this.hostsOriginalIpMap.get(url.hostname) || url.hostname;

      /**
       * 处理代理规则修改请求
       * 如果找到了匹配的代理规则，执行代理函数修改请求
       */
      /** 如果存在这个“开发者修改请求的函数”，说明开发者需要修改了 */
      if (httpProxyFn) {
        const { value } = await httpProxyFn.next();
        if (value !== null) {
          /**
           * 删除所有304缓存的请求头
           * 确保请求不会使用缓存，总是获取最新的内容
           */
          delete httpProxyReq.headers["if-match"];
          delete httpProxyReq.headers["if-modified-since"];
          delete httpProxyReq.headers["if-none-match"];
          delete httpProxyReq.headers["if-unmodified-since"];

          /**
           * 应用开发者对请求的修改
           * 将开发者通过代理函数返回的修改应用到请求对象
           */
          Object.entries(value || {}).forEach(([key, value]) => {
            httpProxyReq[key] = value;
          });
        } else {
          // console.log("不对外发请求");
          /**
           * 直接返回响应，不发送请求到目标服务器
           * 当代理函数返回null时，直接构造响应返回给客户端
           */
          const httpProxyRes: IHttpProxyRes = {
            code: 200,
            headers: {},
            body: "",
          };

          /**
           * 应用开发者对响应的修改
           * 将开发者通过代理函数返回的修改应用到响应对象
           */
          /** 混合用户修改过的 */
          Object.entries((await httpProxyFn.next(httpProxyRes)).value || {}).forEach(([key, value]) => {
            httpProxyRes[key] = value;
          });

          /**
           * 发送响应给客户端
           * 将修改后的响应发送给客户端
           */
          res.writeHead(httpProxyRes.code, httpProxyRes.headers);
          res.end(httpProxyRes.body);
          return;
        }
      }

      /**
       * 创建请求选项
       * 配置发送到目标服务器的请求选项
       */
      const requestOptions: https.RequestOptions = {
        method: httpProxyReq.method,
        headers: httpProxyReq.headers,
        // allow legacy server
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
      };

      /**
       * 配置系统代理
       * 如果需要通过系统代理发送请求，配置createConnection函数
       */
      if (this.initialOperatingSystemHttpProxys) {
        requestOptions.createConnection = ({ host }, oncreate: (err: Error | null, socket: net.Socket) => void) => {
          host = httpProxyReq.headers?.host || host || "";
          const port = Number(httpProxyReq.url.port || (url.protocol === "https:" ? 443 : 80));
          this.operatingSystemHttpProxy
            .getHttpProxySocket(host, port, this.initialOperatingSystemHttpProxys)
            // @ts-ignore
            .then(socket =>
              oncreate(null, url.protocol === "https:" ? tls.connect({ servername: host, socket }) : socket),
            );
          return undefined;
        };
      }

      /**
       * 创建对目标服务器的请求
       * 根据URL协议选择http或https模块发送请求
       */
      const remoteReq = (url.protocol === "https:" ? https : http).request(
        httpProxyReq.url,
        requestOptions,
        async remoteRes => {
          /**
           * 处理目标服务器的响应
           * 如果有匹配的代理规则，执行代理函数修改响应
           */
          if (httpProxyFn) {
            const httpProxyRes: IHttpProxyRes = {
              code: remoteRes.statusCode || 200,
              headers: remoteRes.headers,
            };

            /**
             * 获取响应体
             * 接收目标服务器的完整响应体
             */
            const body = (httpProxyRes.body = await recvAll(remoteRes));

            /**
             * 处理gzip压缩的响应
             * 如果响应体是gzip压缩的，尝试解压缩
             */
            if (body && (httpProxyRes.headers || {})["content-encoding"] === "gzip") {
              if (
                !(await new Promise(resolve =>
                  zlib.gunzip(body, (err, buf) => {
                    if (err) {
                      console.error(err);
                      resolve(false);
                    }
                    resolve(true);
                    delete httpProxyRes.headers["content-encoding"];
                    httpProxyRes.body = buf;
                  }),
                ))
              ) {
                res.statusCode = 500;
                res.end("zlib err");
                return;
              }
            }

            /**
             * 删除content-length头
             * 因为响应体可能被修改，需要删除原始的content-length头
             */
            delete httpProxyRes.headers["content-length"];

            /**
             * 应用开发者对响应的修改
             * 将开发者通过代理函数返回的修改应用到响应对象
             */
            Object.entries((await httpProxyFn.next(httpProxyRes)).value || {}).forEach(([key, value]) => {
              httpProxyRes[key] = value;
            });

            /**
             * 发送响应给客户端
             * 将修改后的响应发送给客户端
             */
            res.writeHead(httpProxyRes.code, httpProxyRes.headers);
            res.end(httpProxyRes.body);
          } else {
            /**
             * 直接转发响应
             * 如果没有匹配的代理规则，直接将目标服务器的响应转发给客户端
             */
            res.writeHead(remoteRes.statusCode || 200, remoteRes.headers);
            remoteRes.pipe(res);
          }

          /**
           * 处理响应错误
           * 监听目标服务器响应的错误事件
           */
          remoteRes.once("error", console.error);
        },
      );

      /**
       * 处理请求错误
       * 监听对目标服务器请求的错误事件
       */
      remoteReq.once("error", e => {
        console.log("\x1B[31mError\t", req.method, "\t", url.host, "\x1B[0m");
        res.statusCode = 500;
        res.end("Proxy Error: Unable connect to server," + e + "," + httpProxyReq.url);
      });

      /**
       * 发送请求体
       * 根据是否有匹配的代理规则，选择发送方式
       */
      if (httpProxyFn) {
        remoteReq.end(httpProxyReq.body);
      } else {
        req.pipe(remoteReq);
      }

      /**
       * 日志输出
       * 输出请求信息到控制台，包括协议、方法、进程名（如果启用）和URL
       */
      const showUrl = new URL(String(url));
      showUrl.host = httpProxyReq.headers.host;
      this.opt.disableLog ||
        console.log(
          showUrl.protocol,
          "\t",
          String(req.method || "").padEnd(7, " "),
          "\t",
          ...(this.opt.showProcessName
            ? [await getProcessNameByPort(req.socket.remotePort, req.socket.localPort), "\t"]
            : []),
          String(showUrl).substring(0, 100) + (String(showUrl).length > 100 ? "..." : ""),
        );
    },
  );

  /**
   * 系统代理设置
   * 用于管理系统的代理设置
   */
  private readonly operatingSystemHttpProxy: OperatingSystemHttpProxy;

  /**
   * 最开始的系统代理规则
   * 存储系统原始的代理设置，用于恢复或使用系统代理
   */
  private initialOperatingSystemHttpProxys?: Awaited<ReturnType<OperatingSystemHttpProxy["get"]>>;

  /**
   * 创建一个HTTP代理服务器
   * @param hosts 需要代理的域名列表
   * @param opt 代理服务器的配置选项
   * @param certificateCenter 证书中心的URL，用于获取HTTPS代理所需的SSL证书或回调函数
   */
  constructor(
    hosts: string[],
    opt: IHttpProxyOpt = {},
    certificateCenter: HttpProxy["certificateCenter"] = new URL("https://tool.hejianpeng.cn/certificate/"),
  ) {
    this.hosts = hosts || [];
    this.routeMap = opt?.routeMap || new Map();
    opt.proxyBindIp = opt?.proxyBindIp || "127.0.0.1";
    opt.proxyBindPort = opt?.proxyBindPort || 1080;
    opt.listenRequestPorts = opt?.listenRequestPorts || [80, 443];
    opt.proxyMode = opt?.proxyMode;
    opt.autoSettings = opt?.autoSettings ?? true;
    opt.showProcessName = opt?.showProcessName ?? true;
    opt.disableLog = opt?.disableLog ?? false;
    this.opt = opt;
    this.certificateCenter = certificateCenter;
    this.proxyServer.once("error", console.error);
    this.operatingSystemHttpProxy = new OperatingSystemHttpProxy(opt.autoSettings);
    /** 如果需要使用系统代理，就要先保存最开始的系统代理规则 */
    if (opt.useSystemProxy) {
      this.operatingSystemHttpProxy.get().then(opt => {
        this.initialOperatingSystemHttpProxys = opt;
      });
    }

    Promise.all(
      hosts.map(
        host =>
          new Promise(resolve =>
            dns.lookup(host, (err, addresses) => {
              if (err || !addresses) {
                console.warn("\x1B[33m找不到", host, "的DNS记录，已解析到本地:127.0.0.1\x1B[0m");
                resolve("127.0.0.1");
                return;
              }
              resolve(addresses);
            }),
          ) as Promise<string>,
      ),
    ).then(ips => {
      /**
       * 获取所有需要代理的域名的IP地址
       * 检查IP地址是否与代理服务器地址冲突
       */
      const { proxyMode } = opt;
      this.opt.disableLog || console.log("需要代理的域名对应的ip");
      ips.forEach((ip, i) => {
        if (ip) {
          if (
            proxyMode === undefined &&
            ip === opt.proxyBindIp &&
            opt.listenRequestPorts?.includes(opt.proxyBindPort || 0)
          ) {
            console.log(
              "域名",
              this.hosts[i],
              "的IP地址和绑定端口不能与代理地址(",
              opt.proxyBindIp,
              opt.proxyBindPort,
              ")相同",
            );
            throw new TypeError("请关闭其他正在运行的HttpProxy或DnsServer");
          }
          this.opt.disableLog || console.log(ip.padEnd(15, " "), "\t", this.hosts[i]);
          this.hostsOriginalIpMap.set(this.hosts[i], ip);
        }
      });
      if (typeof this.certificateCenter !== "function") {
        console.log("\t");
        console.warn(
          `\x1B[44m\x1B[37m【重要提示】使用前请先下载并安装CA根证书，下载地址${this.certificateCenter}，否则不支持HTTPS\x1B[0m`,
        );
      }

      /**
       * HTTP代理模式
       * 如果没有指定proxyMode，则使用普通的HTTP代理模式
       */
      if (proxyMode === undefined) {
        // "httpProxy"
        /**
         * 监听connect方法
         * 处理HTTPS隧道建立请求，一般用于普通代理服务器升级为HTTPS时
         */
        this.proxyServer.on("connect", async ({ headers }, socket) => {
          const [host, port] = getHostPort(headers.host);
          // console.log("new", host);
          if (host) {
            /**
             * 动态添加新域名
             * 如果启用了onNewHost功能，尝试添加新域名
             */
            if (opt.onNewHost && (await opt.onNewHost(host))) {
              await this.onNewHost(host);
            }

            /**
             * 回复TLS隧道已建立
             * 告诉浏览器TLS隧道已成功打开
             */
            socket.write(`HTTP/1.1 200 Connection established\r\n\r\n`);

            /**
             * 处理不需要解包的域名
             * 如果启用了onlyProxyHostInList选项，且域名不在代理列表中，则直接转发不解包
             */
            if (opt.onlyProxyHostInList && !this.hostsOriginalIpMap.has(host)) {
              this.opt.disableLog || console.log("不解包，直接转发", host, port);
              const remoteSock = this.initialOperatingSystemHttpProxys
                ? await this.operatingSystemHttpProxy.getHttpProxySocket(
                    host,
                    port,
                    this.initialOperatingSystemHttpProxys,
                  )
                : net.connect({ host, port });
              remoteSock.on("error", () => socket.end());
              socket.on("error", () => remoteSock.end());
              remoteSock.pipe(socket);
              socket.pipe(remoteSock);
              return;
            }

            /**
             * 创建TLS服务器
             * 为客户端连接创建TLS服务器，使用从证书中心获取的证书
             */
            try {
              this.proxyServer.emit(
                "connection",
                /** 把soket套一层SSL */
                new tls.TLSSocket(socket, {
                  isServer: true,
                  secureContext: await this.createSecureContext(host),
                }),
              );
            } catch (e) {
              socket.end();
            }
          }
        });

        /**
         * 启动代理服务器
         * 在指定的IP和端口上监听HTTP代理请求
         */
        this.proxyServer.listen(opt.proxyBindPort, opt.proxyBindIp);

        /**
         * 自动配置系统代理设置
         * 如果启用了autoSettings选项，自动配置系统代理设置
         */
        if (this.opt.autoSettings) {
          this.operatingSystemHttpProxy
            .set({
              proxyIp: `${opt.proxyBindIp}:${opt.proxyBindPort}`,
              status: this.opt.onNewHost
                ? EOperatingSystemHttpProxyStatus.使用代理服务器
                : EOperatingSystemHttpProxyStatus.使用脚本和代理,
              pac: `http://${opt.proxyBindIp}:${opt.proxyBindPort}/pg_pac_script_config/${this.token}`,
            })
            .then(proxyWin => proxyWin.get())
            .then(arr => {
              this.opt.disableLog || console.log("已自动帮您修改系统设置：");
              for (const { proxyIp, pac, networkService } of arr) {
                this.opt.disableLog || console.log(networkService, "代理服务器", proxyIp, "PAC脚本", pac);
              }
            });
        } else {
          /**
           * 输出手动配置指南
           * 如果未启用自动配置，输出手动配置系统代理的指南
           */
          console.log(
            `\x1B[32m*** 若需使用普通代理模式，请进入系统设置代理服务器${opt.proxyBindIp}:${opt.proxyBindPort}\x1B[0m`,
          );
          console.log(
            `\x1B[32m*** 若需使用PAC模式，请设置代理服务器"使用设置脚本"→"脚本地址"输入：http://${opt.proxyBindIp}:${opt.proxyBindPort}/pg_pac_script_config/${this.token}\x1B[0m`,
          );
        }
      } else {
        /**
         * DNS代理模式
         * 如果指定了proxyMode，使用DNS代理模式
         */
        const that = this;

        /**
         * 创建TLS服务器
         * 用于处理HTTPS请求，将HTTPS请求转换为HTTP请求
         */
        const tlsServer = tls.createServer(
          {
            async SNICallback(servername, callback) {
              if (!servername) {
                callback(new Error("not host"));
                return;
              }
              try {
                callback(null, await that.createSecureContext(servername));
              } catch (e: any) {
                callback(e);
              }
            },
          },
          sock => {
            /** 丢给this.proxyServer进行解析和对外请求 */
            this.proxyServer.emit("connection", sock);
          },
        );

        /**
         * TCP连接监听器
         * 根据第一个字节判断是HTTP还是HTTPS请求，分别交给不同的服务器处理
         */
        const connectionListener = (sock: net.Socket) => {
          sock.once("readable", () => {
            /** 当有数据时，不消费readable流中的数据，直接读取缓存到的数据判断http还是https请求 */
            const chunk = sock.read(1);
            if (!chunk) {
              return;
            }
            sock.unshift(chunk);
            (chunk[0] === 0x16 ? tlsServer : this.proxyServer).emit("connection", sock);
          });
        };

        /**
         * 创建TCP代理
         * 为每个需要代理的域名和端口创建TCP代理
         */
        const tcpProxy = new TcpProxy(proxyMode);
        this.hosts.forEach(host => {
          /** 添加本地DNS服务器的解析规则 */
          (opt.listenRequestPorts || []).map(port =>
            tcpProxy.add({
              host,
              port,
              connectionListener,
              localIPStartPos: 0,
            }),
          );
        });

        /**
         * 配置DNS服务器
         * 如果proxyMode是DnsServer实例，配置DNS服务器的行为
         */
        if (proxyMode instanceof DnsServer) {
          const { onNewHost, proxyBindIp } = this.opt || {};
          if (proxyBindIp) {
            tcpProxy.localIPtoString = () => proxyBindIp;
          }

          /**
           * 设置DNS查询回调
           * 处理DNS查询请求，动态添加新域名到代理列表
           */
          proxyMode.onDnsLookup = async ({ QNAME }, answer) => {
            const { RDATA, TYPE } = answer || {};
            const { certificateCenter } = this;
            if (
              onNewHost &&
              TYPE === EDnsResolveType.A &&
              RDATA &&
              !this.hostsOriginalIpMap.has(QNAME) &&
              (typeof certificateCenter === "function" || QNAME !== certificateCenter.hostname) &&
              (await onNewHost(QNAME))
            ) {
              // console.log("手动添加", QNAME);
              this.hosts.push(QNAME);
              this.hostsOriginalIpMap.set(QNAME, RDATA);
              try {
                await Promise.all(
                  (opt.listenRequestPorts || []).map(port =>
                    tcpProxy.add({
                      host: RDATA,
                      port,
                      connectionListener,
                      localIPStartPos: 0,
                    }),
                  ),
                );
                proxyMode.add(tcpProxy.localIPtoString(tcpProxy.routeMap.get(RDATA) || 0), QNAME);
              } catch (e) {
                console.log("添加失败", QNAME, e);
              }
            }
            return proxyMode.hostsMap.get(QNAME) ?? answer?.RDATA;
          };
        }
      }
    });
  }

  /**
   * 添加代理规则，接受2个函数参数
   *
   * 该方法用于添加一个新的代理规则，包括匹配条件和处理函数
   *
   * @param regFn 代理规则匹配函数，接收请求方法、URL和请求头，返回一个布尔值表示是否匹配该规则
   * @param fn 代理处理函数，用于处理匹配到的请求和响应，可以修改请求和响应的内容
   * @returns 返回this实例，支持链式调用
   */
  public addProxyRule(regFn: IHttpProxyRegFn, fn: IHttpProxyFn) {
    this.routeMap.set(regFn, fn);
    return this;
  }
}

// 测试用例
/**
 * 测试用例1：拦截百度首页请求
 *
 * 创建一个代理服务器，代理www.baidu.com域名的请求
 * 添加一个规则，拦截所有请求，如果是首页请求，则直接返回"test"，不发送请求到目标服务器
 * 如果是其他请求，则不修改请求和响应
 */
// new HttpProxy(["www.baidu.com"]).addProxyRule(
//   (method, url, headers) => true,
//   async function* (localReq) {
//     if (localReq.url.pathname === "/") {
//       // 不对外发请求
//       yield null;
//     } else {
//       // 不修改req
//       yield;
//     }
//     return localReq.url.pathname === "/"
//       ? // 修改为test
//         { body: "test" }
//       : // 不修改res
//         undefined;
//   }
// );

/**
 * 测试用例2：记录百度翻译请求和响应
 *
 * 创建一个代理服务器，代理fanyi.baidu.com和www.baidu.com域名的请求
 * 使用DNS代理模式，并添加一个规则，拦截所有请求并记录请求和响应内容
 * 同时将所有百度页面的响应修改为"禁止访问百度"
 */
// import { SaveLog } from "./SaveLog";
// const saveLog = new SaveLog();
// new HttpProxy(["fanyi.baidu.com", "www.baidu.com"], {
//   proxyMode: new DnsServer(),
//   async onNewHost(host) {
//     console.log("onNewHost", host);
//     return false;
//   },
// }).addProxyRule(
//   (method, url, headers) => {
//     return true;
//   },
//   async function* (localReq) {
//     console.log(String(localReq.body));
//     const remoteReq: Partial<IHttpProxyReq> = {};
//     const remoteRes = yield remoteReq;
//     console.log(String(remoteRes.body));
//     const localRes: Partial<IHttpProxyRes> = {
//       body: "禁止访问百度",
//     };
//     saveLog.add({
//       localReq: { ...localReq, body: String(localReq.body) },
//       remoteReq,
//       localRes,
//       remoteRes: { ...remoteRes, body: String(remoteRes.body) },

//       time: new Date().toLocaleString(),
//     });

//     return localRes;
//   }
// );

/**
 * 测试用例3：选择性代理和系统代理
 *
 * 创建一个代理服务器，代理www.baidu.com域名的请求
 * 使用系统代理，只代理特定域名列表中的域名，其他域名直接连接
 * 动态添加百度域名和Google翻译域名到代理列表
 */
// new HttpProxy(["www.baidu.com"], {
//   // proxyMode: new DnsServer(),
//   useSystemProxy: true,
//   onlyProxyHostInList: true,
//   async onNewHost(host) {
//     console.log(host);
//     return /baidu\.com$/.test(host) || host.includes("translate.google.com");
//   },
// }).addProxyRule(
//   (method, url, headers) => true,
//   async function* (localReq) {
//     const a = yield {};

//     return localReq.url.pathname === "/"
//       ? // 修改为test
//         { body: "test" }
//       : // 不修改res
//         undefined;
//   }
// );
