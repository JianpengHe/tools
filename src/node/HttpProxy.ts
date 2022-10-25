import * as net from "net";
import * as tls from "tls";
import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import { Duplex, Readable } from "stream";
export type IHttpProxyReq = {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body?: Buffer;
};
export type IHttpProxyRes = {
  code: number;
  headers: IncomingHttpHeaders;
  body?: Buffer | string;
};
export type IHttpProxyFn = (
  localReq: IHttpProxyReq
) => AsyncGenerator<Partial<IHttpProxyReq>, Partial<IHttpProxyRes>, IHttpProxyRes>;
const getHostPort = (rawHost: string): [string, number] => {
  const [_, host, port] = (rawHost || "").match(/^(.+):(\d+)$/) || [];
  return [host, Number(port || 0)];
};
const recvAll = async (stream: Readable | Duplex) => {
  const body: Buffer[] = [];
  for await (const chuck of stream) {
    body.push(chuck);
  }
  return Buffer.concat(body);
};
export class HttpProxy {
  private hosts: string[];
  public routeMap: Map<RegExp, IHttpProxyFn>;
  public proxyServer: net.Server;
  private async requestListener(req: IncomingMessage, res: ServerResponse) {
    if (!req?.headers?.host || !req.url) {
      res.statusCode = 404;
      res.end("404");
      return;
    }
    const encrypted = req.socket["encrypt" + "ed"];
    /** 判断回环 */
    if (!encrypted && req.url[0] === "/") {
      res.statusCode = 403;
      res.end("proxyServer");
      return;
    }
    const url = new URL(encrypted ? `https://${req.headers.host}${req.url}` : req.url);
    const httpProxyReq: IHttpProxyReq = {
      method: req.method?.toUpperCase() || "GET",
      url,
      headers: req.headers,
    };
    let httpProxyFn: AsyncGenerator<Partial<IHttpProxyReq>, Partial<IHttpProxyRes>, IHttpProxyRes> | undefined =
      undefined;
    if (this.hosts.includes(url.host)) {
      for (const [reg, fn] of this.routeMap) {
        if (reg.test(url.href)) {
          httpProxyReq.body = await recvAll(req);
          httpProxyReq.headers["accept-encoding"] = "gzip";
          httpProxyFn = fn(httpProxyReq);
          break;
        }
      }
    }
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

    if (httpProxyFn) {
      remoteReq.end(httpProxyReq.body);
    } else {
      req.pipe(remoteReq);
    }
    remoteReq?.socket?.on("lookup", (...a) => console.log(a));
    remoteReq.once("error", () => {
      console.log("Error\t", req.method, "\t", url.host);
    });
    // console.log(url.protocol, "\t", req.method, "\t", String(url));
  }

  constructor(hosts: string[], proxyPort: number = 1080, proxyIp: string = "127.0.0.1") {
    this.hosts = hosts;
    this.routeMap = new Map();
    this.proxyServer = http.createServer(this.requestListener.bind(this));
    this.proxyServer.on("connect", ({ headers }, socket) => {
      const [host, _] = getHostPort(headers.host);
      if (host) {
        https
          .get(`https://tool.hejianpeng.cn/certificate/${host}`, async res => {
            socket.write(`HTTP/1.1 200 Connection established\r\n\r\n`);
            const tlsSocket = new tls.TLSSocket(socket, {
              isServer: true,
              secureContext: tls.createSecureContext(JSON.parse(String(await recvAll(res)))),
            });
            // const localSocket = net.connect({ port: proxyPort, host: proxyIp });
            // localSocket.pipe(tlsSocket);
            // tlsSocket.pipe(localSocket);
            this.proxyServer.emit("connection", tlsSocket);
            res.once("error", () => {
              socket.end();
            });
          })
          .once("error", () => {
            socket.end();
          });
      }
    });
    this.proxyServer.once("error", console.error);
    this.proxyServer.listen(proxyPort, proxyIp);
    console.warn(
      `使用前请先下载并安装CA根证书，下载地址https://tool.hejianpeng.cn/certificate/，并进入系统设置代理服务器${proxyIp}:${proxyPort}`
    );
  }
  public listen(url: RegExp, fn: IHttpProxyFn) {
    this.routeMap.set(url, fn);
    return this;
  }
}
// new HttpProxy(["www.baidu.com"], 1080).listen(/.+/, async function* (localReq) {
//   console.log(String(localReq.body));
//   const remoteReq: Partial<IHttpProxyReq> = {};
//   const remoteRes = yield remoteReq;
//   console.log(String(remoteRes.body));
//   const localRes: Partial<IHttpProxyRes> = { body: "禁止访问百度" };
//   return localRes;
// });
