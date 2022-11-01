import * as net from "net";
import * as tls from "tls";
import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import * as dns from "dns";
import * as child_process from "child_process";
import { DnsServer } from "./DnsServer";
import { recvAll } from "./RecvBuf";

/** 使用PG的公共证书签发平台 */
const certificateCenter = "https://tool.hejianpeng.cn/certificate/";
export type IHttpProxyReq = {
  method: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  body?: Buffer;
};
export type IHttpProxyRes = {
  code: number;
  headers: http.IncomingHttpHeaders;
  body?: Buffer | string;
};
export type IHttpProxyFn = (
  localReq: IHttpProxyReq
) => AsyncGenerator<Partial<IHttpProxyReq>, Partial<IHttpProxyRes>, IHttpProxyRes>;
export type IHttpProxyRegFn = (method: string, url: URL, headers: http.IncomingHttpHeaders) => boolean;

export type IHttpProxyOpt = {
  runWith?: "httpProxy" | "modifyHostsFile" | "dns";
  proxyBindIp?: string; // "127.0.0.1"
  proxyBindPort?: number; // 1080
  listenRequestPorts?: number[]; //[80,443]
  routeMap?: Map<IHttpProxyRegFn, IHttpProxyFn>;
};

const getHostPort = (rawHost: string): [string, number] => {
  const [_, host, port] = (rawHost || "").match(/^(.+):(\d+)$/) || [];
  return [host, Number(port || 0)];
};

export const createSecureContext = async (host: string): Promise<tls.SecureContext> =>
  new Promise((resolve, reject) => {
    https
      .get(`${certificateCenter}${host}`, async res => {
        res.once("error", reject);
        try {
          resolve(tls.createSecureContext(JSON.parse(String(await recvAll(res)))));
        } catch (e) {
          reject(e);
        }
      })
      .once("error", reject);
  });
export class HttpProxy {
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
  public readonly proxyServer: net.Server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const encrypted = req.socket["encrypt" + "ed"];
      if (!encrypted && req.url === `/pg_pac_script_config`) {
        console.log("读取PAC脚本", await getProcessByPort(req.socket.remotePort, req.socket.localPort));
        res.end(`function FindProxyForURL(url, host) {
        if (${this.hosts.map(host => `dnsDomainIs(host, "${host}")`).join("||")}) {
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
      if (req.headers["pg_no_loop_token"] === this.token) {
        res.end("loop");
        return;
      }
      req.headers["pg_no_loop_token"] = this.token;

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
      let httpProxyFn: AsyncGenerator<Partial<IHttpProxyReq>, Partial<IHttpProxyRes>, IHttpProxyRes> | undefined =
        undefined;

      /** 如果域名在hosts列表中，才交给开发者处理 */
      if (this.hosts.includes(url.host)) {
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
      // if (this.dnsServer) {
      //   httpProxyReq.headers.host = url.host;
      //   url.hostname = this.dnsServer.getRawIp(url.hostname) || url.hostname;
      //   console.log(url, httpProxyReq.headers);
      // }

      /** 如果存在这个“开发者修改请求的函数”，说明开发者需要修改了 */
      if (httpProxyFn) {
        Object.entries((await httpProxyFn.next()).value).forEach(([key, value]) => {
          httpProxyReq[key] = value;
        });
      }

      const remoteReq = (url.protocol === "https:" ? https : http).request(
        httpProxyReq.url,
        { method: httpProxyReq.method, headers: httpProxyReq.headers },
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
            Object.entries((await httpProxyFn.next(httpProxyRes)).value).forEach(([key, value]) => {
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
      remoteReq.once("error", () => {
        console.log("\x1B[31mError\t", req.method, "\t", url.host, "\x1B[0m");
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
        await getProcessByPort(req.socket.remotePort, req.socket.localPort),
        "\t",
        String(showUrl).substring(0, 100) + (String(showUrl).length > 100 ? "..." : "")
      );
    }
  );
  private dnsServer?: DnsServer;
  constructor(hosts: string[], opt: IHttpProxyOpt = {}) {
    this.hosts = hosts || [];
    if (!this.hosts.length) {
      throw new TypeError("hosts：需要代理的域名不能为空");
    }
    this.routeMap = opt?.routeMap || new Map();
    opt.proxyBindIp = opt?.proxyBindIp || "127.0.0.1";
    opt.proxyBindPort = opt?.proxyBindPort || 1080;
    opt.listenRequestPorts = opt?.listenRequestPorts || [80, 443];
    opt.runWith = opt?.runWith || "httpProxy";
    this.opt = opt;
    this.proxyServer.once("error", console.error);
    Promise.all(hosts.map(host => dns.promises.resolve(host))).then(ips => {
      console.log("需要代理的域名对应的ip");
      ips.forEach((ip, i) => {
        if (ip && ip[0]) {
          if (ip[0] === opt.proxyBindIp) {
            console.log("域名", this.hosts[i], "的IP地址不能与代理地址相同");
            throw new TypeError("请关闭其他正在运行的HttpProxy或DnsServer");
          }
          console.log(ip[0].padEnd(15, " "), "\t", this.hosts[i]);
          this.hostsOriginalIpMap.set(this.hosts[i], ip[0]);
        }
      });
      console.log("\t");
      console.warn(
        `\x1B[44m\x1B[37m【重要提示】使用前请先下载并安装CA根证书，下载地址${certificateCenter}，否则不支持HTTPS\x1B[0m`
      );
      if (opt.runWith === "httpProxy") {
        /** 监听connect方法，一般用做普通代理服务器升级https时，请求建立TLS隧道 */
        this.proxyServer.on("connect", async ({ headers }, socket) => {
          const [host, _] = getHostPort(headers.host);
          if (host) {
            /** 先回复一下浏览器：TLS隧道打开啦！！！ */
            socket.write(`HTTP/1.1 200 Connection established\r\n\r\n`);
            try {
              this.proxyServer.emit(
                "connection",
                /** 把soket套一层SSL */
                new tls.TLSSocket(socket, {
                  isServer: true,
                  secureContext: await createSecureContext(host),
                })
              );
            } catch (e) {
              socket.end();
            }
          }
        });
        /** 如果是普通http proxy，则需要监听端口暴露这个代理服务器 */
        this.proxyServer.listen(opt.proxyBindPort, opt.proxyBindIp);

        console.log(
          `\x1B[32m*** 若需使用普通代理模式，请进入系统设置代理服务器${opt.proxyBindIp}:${opt.proxyBindPort}\x1B[0m`
        );
        console.log(
          `\x1B[32m*** 若需使用PAC模式，请设置代理服务器“使用设置脚本”→“脚本地址”输入：http://${opt.proxyBindIp}:${opt.proxyBindPort}/pg_pac_script_config\x1B[0m`
        );
      } else {
        /** tls解析器，把https的请求转换成普通http */
        const tlsServer = tls.createServer(
          {
            async SNICallback(servername, callback) {
              if (!servername) {
                callback(new Error("not host"));
                return;
              }
              try {
                callback(null, await createSecureContext(servername));
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
            (sock["_" + "readableState"].buffer?.head?.data[0] === 0x16 ? tlsServer : this.proxyServer).emit(
              "connection",
              sock
            );
          });
        };
        /** 需要绑定N个端口，就创建N个tcp服务器 */
        (opt.listenRequestPorts || []).map(port => net.createServer(connectionListener).listen(port));
        if (opt.runWith === "dns") {
          /** 直接创建一个代理DNS服务器 */
          this.dnsServer = new DnsServer(53, opt.proxyBindIp);
          this.hosts.forEach(host => {
            /** 添加本地DNS服务器的解析规则 */
            this.dnsServer?.add(opt.proxyBindIp || "", host);
          });
        } else if (opt.runWith === "modifyHostsFile") {
          throw new Error("暂未实现，敬请期待");
        }
      }
    });
  }
  /** 添加代理规则，接受2个函数参数，第一个函数要同步返回一个Boolean代表是否使用代理，第二个函数是对代理的req和res进行修改 */
  public addProxyRule(regFn: IHttpProxyRegFn, fn: IHttpProxyFn) {
    this.routeMap.set(regFn, fn);
    return this;
  }
}
/** 通过通信端口，获取应用名称 */
const getProcessByPort = (remotePort: number = 0, localPort: number = 0) =>
  new Promise(resolve =>
    child_process.exec(`netstat -aonp TCP |findstr ":${remotePort}"`, (err, data) => {
      if (err) {
        resolve("");
        return;
      }
      const pid = (String(data).match(
        new RegExp(
          `TCP\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${remotePort}\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${localPort}\\s+\\S+\\s+(\\d+)`
        )
      ) || [])[1];
      if (!pid) {
        resolve("");
        return;
      }
      child_process.exec(`tasklist /FI "PID eq ${pid}" /NH`, (err, data) =>
        resolve(
          (
            (!err &&
              (String(data)
                .trim()
                .match(new RegExp(`^(.+?)\\s+${pid}`)) || [])[1]) ||
            ""
          ).trim()
        )
      );
    })
  );

// new HttpProxy(["www.baidu.com"], {
//   //runWith: "dns",
// }).addProxyRule(
//   (method, url, headers) => {
//     if (url.pathname.includes("/s")) {
//       return true;
//     }
//     return false;
//   },
//   async function* (localReq) {
//     console.log(String(localReq.body));
//     const remoteReq: Partial<IHttpProxyReq> = {};
//     const remoteRes = yield remoteReq;
//     console.log(String(remoteRes.body));
//     const localRes: Partial<IHttpProxyRes> = { body: "禁止访问百度" };
//     return localRes;
//   }
// );
