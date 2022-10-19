import * as net from "net";
import * as http from "http";
export type IHttpProxyReq = {
  method: string;
  url: URL;
  headers: { [x: string]: string };
  body?: Buffer;
};
export type IHttpProxyRes = {
  code: number;
  headers: { [x: string]: string };
  body?: Buffer;
};
export type IHttpProxyFn = (
  localReq: IHttpProxyReq
) => AsyncGenerator<Partial<IHttpProxyReq>, Partial<IHttpProxyRes>, IHttpProxyRes>;
const headerParse = (headers: string[], socket: net.Socket) => {
  const [method, url] = headers.splice(0, 1)[0].split(" ");
  if (!method || !url) {
    socket.end();
    return false;
  }
  if (url[0] === "/") {
    socket.end(
      `HTTP/1.1 404 not found\r\nDate: ${new Date().toUTCString()}\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: 3\r\n\r\n404`
    );
    return false;
  }
  try {
    const httpProxyReq: IHttpProxyReq = {
      method: method.toUpperCase(),
      url: new URL((method.toUpperCase() === "CONNECT" ? "https://" : "") + url),
      headers: {},
    };
    headers.forEach(header => {
      let p = header.indexOf(":");
      if (p < 0) {
        httpProxyReq.headers[header.toLowerCase()] = "";
      } else {
        httpProxyReq.headers[header.substring(0, p).trim().toLowerCase()] = header.substring(p + 1).trim();
      }
    });
    headers.length = 0;
    return httpProxyReq;
  } catch (e) {
    socket.end();
    return false;
  }
};
export class HttpProxy {
  private hosts: string[];
  public routeMap: Map<RegExp, IHttpProxyFn>;
  public proxyServer: net.Server;
  private connectionListener(socket: net.Socket) {
    socket.once("error", console.error);
    const headers: string[] = [];
    let lastBuf = Buffer.allocUnsafe(0);
    socket.on("readable", () => {
      // 使用循环来确保读取所有当前可用的数据
      while (1) {
        const chunk: Buffer = socket.read();
        if (!chunk) {
          break;
        }
        lastBuf = Buffer.concat([lastBuf, chunk]);
        let p = 0;
        while (1) {
          p = lastBuf.indexOf("\r\n");
          if (p === -1) {
            break;
          }
          const header = String(lastBuf.subarray(0, p + 2)).trim();
          lastBuf = lastBuf.subarray(p + 2);
          if (header) {
            headers.push(header);
          } else if (headers.length) {
            const httpProxyReq = headerParse(headers, socket);
            if (httpProxyReq) {
              checkRoute(httpProxyReq);
            } else {
              headers.length = 0;
              lastBuf = Buffer.allocUnsafe(0);
              return;
            }
          }
        }
      }
    });
    const checkRoute = (httpProxyReq: IHttpProxyReq) => {
      if (httpProxyReq.url.protocol === "http:") {
        http.request(httpProxyReq.url, { headers: httpProxyReq.headers }, res => {});
      }

      if (this.hosts.includes(httpProxyReq.url.host)) {
        const url = String(httpProxyReq.url);
        console.log(url);
        for (const [urlRegExp, httpProxyFn] of this.routeMap) {
          if (urlRegExp.test(url)) {
            console.log("命中");
            // httpProxyFn(httpProxyReq)
          }
        }
      }
    };
    // const remoteReq
  }

  constructor(hosts: string[], proxyPort?: number) {
    this.hosts = hosts;
    this.routeMap = new Map();
    this.proxyServer = net.createServer(socket => this.connectionListener(socket)).listen(proxyPort || 1080);
    this.proxyServer.once("error", console.error);
  }
  public listen(url: RegExp, fn: IHttpProxyFn) {
    this.routeMap.set(url, fn);
    return this;
  }
}

new HttpProxy(["mars-test.myscrm.cn"], 80).listen(/list/, async function* (localReq) {
  console.log(localReq);
  const remoteReq: Partial<IHttpProxyReq> = {};
  const remoteRes = yield remoteReq;
  console.log(remoteRes);
  const localRes: Partial<IHttpProxyRes> = {};
  return localRes;
});
