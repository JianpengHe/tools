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
  localReq: IHttpProxyReq
) => AsyncGenerator<Partial<IHttpProxyReq> | null | undefined, Partial<IHttpProxyRes> | undefined, IHttpProxyRes>;

/** 代理规则，返回一个布尔值代表这个请求是否需要拦截 */
export type IHttpProxyRegFn = (method: string, url: URL, headers: http.IncomingHttpHeaders) => boolean;

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
};

const getHostPort = (rawHost: string): [string, number] => {
  const [_, host, port] = (rawHost || "").match(/^(.+):(\d+)$/) || [];
  return [host, Number(port || 0)];
};

export class HttpProxy {
  /** 使用PG的公共证书签发平台 */
  private readonly certificateCenter: URL;

  /** 获取SSL证书 */
  private readonly createSecureContext = async (host: string): Promise<tls.SecureContext> =>
    new Promise((resolve, reject) => {
      (this.certificateCenter.protocol === "https:" ? https : http)
        .get(`${this.certificateCenter}${host}`, async res => {
          res.once("error", reject);
          try {
            resolve(tls.createSecureContext(JSON.parse(String(await recvAll(res)))));
          } catch (e) {
            reject(e);
          }
        })
        .once("error", reject);
    });

  /** 需要代理哪些域名 */
  private readonly hosts: string[];

  /** 这些域名对应的初始IP */
  private readonly hostsOriginalIpMap: Map<string, string> = new Map();

  /** 唯一标志 */
  public readonly token = (o => {
    while (o.length < 40) {
      o += Math.random().toString(36).substring(2);
    }
    return o;
  })("");

  /** 代理规则哈希表 */
  public readonly routeMap: Map<IHttpProxyRegFn, IHttpProxyFn>;

  /** 对外请求的代理服务器 */
  private readonly opt: IHttpProxyOpt;

  /** 当遇到新域名时 */
  private async onNewHost(hostname: string) {
    this.hosts.push(hostname);
    try {
      this.hostsOriginalIpMap.set(
        hostname,
        net.isIPv4(hostname) ? hostname : (await dns.promises.resolve4(hostname))[0] || ""
      );
    } catch (e) {
      console.log("添加失败", hostname, e);
    }
  }

  /** 本地代理服务器 */
  public readonly proxyServer: net.Server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // console.log(req.url);
      const encrypted = req.socket["encrypt" + "ed"];
      if (!encrypted && req.url === `/pg_pac_script_config/${this.token}`) {
        console.log(
          "读取PAC脚本",
          this.opt.showProcessName ? await getProcessNameByPort(req.socket.remotePort, req.socket.localPort) : ""
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
      if (!req?.headers?.host || !req.url) {
        res.statusCode = 404;
        res.end("404");
        return;
      }
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

      /** 浏览器到代理服务器的req句柄，交由开发者修改后，使用该req句柄请求远端服务器 */
      const httpProxyReq: IHttpProxyReq = {
        method: req.method?.toUpperCase() || "GET",
        url,
        headers: req.headers,
      };

      /** 开发者修改请求的函数 */
      let httpProxyFn: ReturnType<IHttpProxyFn> | undefined = undefined;
      const { proxyMode, onNewHost, proxyBindIp } = this.opt;
      if (
        !encrypted &&
        onNewHost &&
        proxyMode === undefined &&
        url.hostname !== proxyBindIp &&
        (await onNewHost(url.hostname))
      ) {
        await this.onNewHost(url.hostname);
      }
      /** 如果域名在hosts列表中，才交给开发者处理 */
      if (this.hosts.includes(url.hostname)) {
        for (const [regFn, fn] of this.routeMap) {
          /**看满足哪条“代理规则” */
          if (regFn(httpProxyReq.method, url, httpProxyReq.headers)) {
            httpProxyReq.body = await recvAll(req);
            httpProxyReq.headers["accept-encoding"] = "gzip";
            httpProxyFn = fn(httpProxyReq);
            break;
          }
        }
      }

      httpProxyReq.headers.host = url.host;
      url.hostname = this.hostsOriginalIpMap.get(url.hostname) || url.hostname;

      /** 如果存在这个“开发者修改请求的函数”，说明开发者需要修改了 */
      if (httpProxyFn) {
        const { value } = await httpProxyFn.next();
        if (value !== null) {
          /** 删除所有304缓存的请求头 */
          delete httpProxyReq.headers["if-match"];
          delete httpProxyReq.headers["if-modified-since"];
          delete httpProxyReq.headers["if-none-match"];
          delete httpProxyReq.headers["if-unmodified-since"];
          Object.entries(value || {}).forEach(([key, value]) => {
            httpProxyReq[key] = value;
          });
        } else {
          // console.log("不对外发请求");
          const httpProxyRes: IHttpProxyRes = {
            code: 200,
            headers: {},
            body: "",
          };
          /** 混合用户修改过的 */
          Object.entries((await httpProxyFn.next(httpProxyRes)).value || {}).forEach(([key, value]) => {
            httpProxyRes[key] = value;
          });
          res.writeHead(httpProxyRes.code, httpProxyRes.headers);
          res.end(httpProxyRes.body);
          return;
        }
      }

      const remoteReq = (url.protocol === "https:" ? https : http).request(
        httpProxyReq.url,
        {
          method: httpProxyReq.method,
          headers: httpProxyReq.headers,
          // allow legacy server
          secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
        },
        async remoteRes => {
          /** 需要走拦截 */
          if (httpProxyFn) {
            const httpProxyRes: IHttpProxyRes = {
              code: remoteRes.statusCode || 200,
              headers: remoteRes.headers,
            };
            /** 获取全部body */
            const body = (httpProxyRes.body = await recvAll(remoteRes));
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
                  })
                ))
              ) {
                res.statusCode = 500;
                res.end("zlib err");
                return;
              }
            }
            delete httpProxyRes.headers["content-length"];
            /** 混合用户修改过的 */
            Object.entries((await httpProxyFn.next(httpProxyRes)).value || {}).forEach(([key, value]) => {
              httpProxyRes[key] = value;
            });
            res.writeHead(httpProxyRes.code, httpProxyRes.headers);
            res.end(httpProxyRes.body);
          } else {
            res.writeHead(remoteRes.statusCode || 200, remoteRes.headers);
            remoteRes.pipe(res);
          }
          remoteRes.once("error", console.error);
        }
      );
      remoteReq.once("error", e => {
        console.log("\x1B[31mError\t", req.method, "\t", url.host, "\x1B[0m");
        res.statusCode = 500;
        res.end("Proxy Error: Unable connect to server," + e + "," + httpProxyReq.url);
      });
      if (httpProxyFn) {
        remoteReq.end(httpProxyReq.body);
      } else {
        req.pipe(remoteReq);
      }
      const showUrl = new URL(String(url));
      showUrl.host = httpProxyReq.headers.host;
      console.log(
        showUrl.protocol,
        "\t",
        String(req.method || "").padEnd(7, " "),
        "\t",
        ...(this.opt.showProcessName
          ? [await getProcessNameByPort(req.socket.remotePort, req.socket.localPort), "\t"]
          : []),
        String(showUrl).substring(0, 100) + (String(showUrl).length > 100 ? "..." : "")
      );
    }
  );

  constructor(hosts: string[], opt: IHttpProxyOpt = {}, certificateCenter = "https://tool.hejianpeng.cn/certificate/") {
    this.hosts = hosts || [];
    this.routeMap = opt?.routeMap || new Map();
    opt.proxyBindIp = opt?.proxyBindIp || "127.0.0.1";
    opt.proxyBindPort = opt?.proxyBindPort || 1080;
    opt.listenRequestPorts = opt?.listenRequestPorts || [80, 443];
    opt.proxyMode = opt?.proxyMode;
    opt.autoSettings = opt?.autoSettings ?? true;
    opt.showProcessName = opt?.showProcessName ?? true;
    this.opt = opt;
    this.certificateCenter = new URL(certificateCenter);
    this.proxyServer.once("error", console.error);
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
            })
          ) as Promise<string>
      )
    ).then(ips => {
      const { proxyMode } = opt;
      console.log("需要代理的域名对应的ip");
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
              ")相同"
            );
            throw new TypeError("请关闭其他正在运行的HttpProxy或DnsServer");
          }
          console.log(ip.padEnd(15, " "), "\t", this.hosts[i]);
          this.hostsOriginalIpMap.set(this.hosts[i], ip);
        }
      });
      console.log("\t");
      console.warn(
        `\x1B[44m\x1B[37m【重要提示】使用前请先下载并安装CA根证书，下载地址${this.certificateCenter}，否则不支持HTTPS\x1B[0m`
      );

      if (proxyMode === undefined) {
        // "httpProxy"
        /** 监听connect方法，一般用做普通代理服务器升级https时，请求建立TLS隧道 */
        this.proxyServer.on("connect", async ({ headers }, socket) => {
          const [host, port] = getHostPort(headers.host);
          // console.log("new", host);
          if (host) {
            if (opt.onNewHost && (await opt.onNewHost(host))) {
              await this.onNewHost(host);
            }

            /** 先回复一下浏览器：TLS隧道打开啦！！！ */
            socket.write(`HTTP/1.1 200 Connection established\r\n\r\n`);
            /** 不走代理，直连 */
            if (opt.onlyProxyHostInList && !this.hostsOriginalIpMap.has(host)) {
              // console.log("不代理，直连", host);
              const remoteSock = net.connect({ host, port });
              remoteSock.on("error", () => socket.end());
              socket.on("error", () => remoteSock.end());
              remoteSock.pipe(socket);
              socket.pipe(remoteSock);
              return;
            }
            try {
              this.proxyServer.emit(
                "connection",
                /** 把soket套一层SSL */
                new tls.TLSSocket(socket, {
                  isServer: true,
                  secureContext: await this.createSecureContext(host),
                })
              );
            } catch (e) {
              socket.end();
            }
          }
        });
        /** 如果是普通http proxy，则需要监听端口暴露这个代理服务器 */
        this.proxyServer.listen(opt.proxyBindPort, opt.proxyBindIp);
        if (this.opt.autoSettings) {
          new OperatingSystemHttpProxy(true)
            .set({
              proxyIp: `${opt.proxyBindIp}:${opt.proxyBindPort}`,
              status: this.opt.onNewHost
                ? EOperatingSystemHttpProxyStatus.使用代理服务器
                : EOperatingSystemHttpProxyStatus.使用脚本和代理,
              pac: `http://${opt.proxyBindIp}:${opt.proxyBindPort}/pg_pac_script_config/${this.token}`,
            })
            .then(proxyWin => proxyWin.get())
            .then(arr => {
              console.log("已自动帮您修改系统设置：");
              for (const { proxyIp, pac, networkService } of arr) {
                console.log(networkService, "代理服务器", proxyIp, "PAC脚本", pac);
              }
            });
        } else {
          console.log(
            `\x1B[32m*** 若需使用普通代理模式，请进入系统设置代理服务器${opt.proxyBindIp}:${opt.proxyBindPort}\x1B[0m`
          );
          console.log(
            `\x1B[32m*** 若需使用PAC模式，请设置代理服务器“使用设置脚本”→“脚本地址”输入：http://${opt.proxyBindIp}:${opt.proxyBindPort}/pg_pac_script_config/${this.token}\x1B[0m`
          );
        }
      } else {
        const that = this;
        /** tls解析器，把https的请求转换成普通http */
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
          }
        );
        /** 多个TCP服务器复用的监听器 */
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
        /** 需要绑定N个端口，就创建N个tcp服务器 */
        const tcpProxy = new TcpProxy(proxyMode);
        this.hosts.forEach(host => {
          /** 添加本地DNS服务器的解析规则 */
          (opt.listenRequestPorts || []).map(port =>
            tcpProxy.add({
              host,
              port,
              connectionListener,
              localIPStartPos: 0,
            })
          );
        });
        if (proxyMode instanceof DnsServer) {
          const { onNewHost, proxyBindIp } = this.opt || {};
          if (proxyBindIp) {
            tcpProxy.localIPtoString = () => proxyBindIp;
          }
          proxyMode.onDnsLookup = async ({ QNAME }, answer) => {
            const { RDATA, TYPE } = answer || {};
            if (
              onNewHost &&
              TYPE === EDnsResolveType.A &&
              RDATA &&
              !this.hostsOriginalIpMap.has(QNAME) &&
              (await onNewHost(QNAME)) &&
              QNAME !== this.certificateCenter.hostname
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
                    })
                  )
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

  /** 添加代理规则，接受2个函数参数 */
  public addProxyRule(
    /** 同步返回一个Boolean代表是否使用代理 */
    regFn: IHttpProxyRegFn,
    /** 对代理的req和res进行怎样的修改 */
    fn: IHttpProxyFn
  ) {
    this.routeMap.set(regFn, fn);
    return this;
  }
}

// 测试用例
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

// 测试用例2
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

// 测试用例3 不代理走直连
// new HttpProxy(["www.baidu.com"], {
//   // proxyMode: new DnsServer(),
//   onlyProxyHostInList: true,
//   async onNewHost(host) {
//     // console.log(host);
//     return /baidu\.com$/.test(host);
//   },
// }).addProxyRule(
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
