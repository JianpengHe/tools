// 网络爬虫 (Web crawler)
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as tls from "tls";
import * as zlib from "zlib";
import * as path from "path";
import { getHash, recvAll, sleep } from "./utils";

export type IWebCrawlerRequest = https.RequestOptions & { body?: Buffer | string };
export type IWebCrawlerResponse = http.IncomingMessage & { body?: Buffer | string };
export type IWebCrawlerCallBackOpt = {
  readonly url: URL;
  readonly res?: IWebCrawlerResponse;
  readonly req: IWebCrawlerRequest;
  savePath: string | null;
  onInfo?: (info: { from: "net" | "file"; res?: IWebCrawlerResponse }) => void;
};

export type IWebCrawlerOpt = {
  /** 每个请求间隔 */
  sleep?: number;
  /** 最大并发 */
  maxSockets?: number;
  /** 保存到硬盘之前要干点啥（如果使用了硬盘缓存的话，这个回调不会触发） */
  onSave?: (opt: Required<IWebCrawlerCallBackOpt>) => void;
  /** 要读取硬盘文件、发起请求之前干点啥 */
  onRequest?: (opt: IWebCrawlerCallBackOpt) => void;
  /** 使用http网络代理（就是俗称梯子的东西） */
  httpProxy?: {
    host: string;
    port: number;
  };
  /** 保存缓存时是否自动、递归创建目录（默认主动创建目录），若目录不存在会无法写入文件缓存，但不影响整体运行 */
  isMkDir?: boolean;
};
const httpAgentUseProxy = (
  agent: (https.Agent | http.Agent) & { createConnection?: any; totalSocketCount?: any },
  proxyHost: string = "127.0.0.1",
  proxyPort: number = 10809
) => {
  //console.log(agent);
  agent.createConnection = ({ host, port }, oncreate) => {
    //console.log("con!");
    agent.totalSocketCount++;
    http
      .request({
        port: proxyPort,
        host: proxyHost,
        method: "CONNECT",
        path: host + ":" + port,
      })
      .on("connect", (_, socket) => {
        oncreate(null, agent instanceof https.Agent ? tls.connect({ servername: host, socket }) : socket);
        //debugger;
        agent.totalSocketCount--;
        //console.log("got connected!");
      })
      .end();
  };
};
export class WebCrawler {
  public sleep = 100;
  public maxSockets = 10;
  public httpAgent: http.Agent;
  public httpsAgent: https.Agent;
  public isMkDir: boolean = true;
  public onRequest?: IWebCrawlerOpt["onRequest"];
  public onSave?: IWebCrawlerOpt["onSave"];
  constructor(opt?: IWebCrawlerOpt) {
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: this.maxSockets,
      maxFreeSockets: this.maxSockets,
    });
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: this.maxSockets,
      maxFreeSockets: this.maxSockets,
    });
    if (opt?.httpProxy) {
      httpAgentUseProxy(this.httpAgent, opt.httpProxy.host, opt.httpProxy.port);
      httpAgentUseProxy(this.httpsAgent, opt.httpProxy.host, opt.httpProxy.port);
    }
    //console.log(this.httpAgent);
    for (const key in opt) {
      if (key === "httpProxy") {
        continue;
      }
      this[key] = opt[key];
    }
  }

  public async request(rawUrl: string | URL, opt: IWebCrawlerRequest = {}, savePath?: string | null) {
    const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
    const { host, port, pathname, protocol, search } = url;
    opt.host = host;
    opt.port = port;
    opt.path = pathname + (search ? search : "");
    opt.protocol = protocol;
    opt.headers = opt.headers || {};
    opt.headers["accept-encoding"] = "gzip";
    const webCrawlerCallBackOpt: IWebCrawlerCallBackOpt = {
      url,
      req: opt,
      savePath:
        savePath === null
          ? ""
          : savePath || getHash("sha1", String(rawUrl) + opt.method + String(opt.body || ""), "hex") + ".tmp",
    };
    /** 交由开发者修改 */
    this.onRequest && this.onRequest(webCrawlerCallBackOpt);

    const isHttps = opt.protocol === "https:";
    opt.agent = opt.agent || (isHttps ? this.httpsAgent : this.httpAgent);

    if (webCrawlerCallBackOpt.savePath) {
      /** 如果能读到文件 */
      const fileData: Buffer = await (savePath =>
        new Promise(resolve => fs.readFile(savePath, (err, d) => resolve(d))))(webCrawlerCallBackOpt.savePath);
      if (fileData) {
        webCrawlerCallBackOpt.onInfo && webCrawlerCallBackOpt.onInfo({ from: "file" });
        return fileData;
      }
    }
    /** 发起网络请求 */
    const response: IWebCrawlerResponse = await new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(opt, async res => {
        res.once("error", reject);
        const response: IWebCrawlerResponse = res;

        response.body = await recvAll(res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res);
        resolve(response);
      });
      req.once("error", reject);
      req.end(opt.body);
    });
    // @ts-ignore
    webCrawlerCallBackOpt.res = response;
    /** 交由开发者修改 */
    this.onSave && this.onSave(webCrawlerCallBackOpt as Required<IWebCrawlerCallBackOpt>);
    if (webCrawlerCallBackOpt.savePath && response.body && response.body.length) {
      try {
        await fs.promises.writeFile(webCrawlerCallBackOpt.savePath, response.body);
      } catch (e: any) {
        if (this.isMkDir && e.code === "ENOENT" && e.path) {
          try {
            await fs.promises.mkdir(path.parse(e.path).dir, { recursive: true });
            await fs.promises.writeFile(webCrawlerCallBackOpt.savePath, response.body);
          } catch (e) {
            console.log(new Date().toLocaleString(), e);
          }
        } else {
          console.log(new Date().toLocaleString(), e);
        }
      }
    }
    webCrawlerCallBackOpt.onInfo && webCrawlerCallBackOpt.onInfo({ from: "net", res: response });
    if (this.sleep) {
      await sleep(this.sleep);
    }
    return response.body;
  }
}

//测试用例
// (async () => {
//   const getSavePath = (time: string, forecast: string) => {
//     if (forecast) {
//       const timestamp = new Date(
//         "20" + [...(time.match(/\d{2}/g) || [])].map((a, i) => a + `-- ::`[i]).join("") + "00"
//       ).getTime();
//       return `${new Date(timestamp + Number(forecast) * 6 * 60 * 1000)
//         .toLocaleString("zh-CN")
//         .replace(/[^\d]/g, " ")
//         .replace(/\s(\d)(?=\s)/g, (_, a) => `0${a}`)
//         .replace(/\s/g, "")
//         .substring(2, 12)}.forecast@${time}.png`;
//     }
//     return `${time}.png`;
//   };
//   const webCrawler = new WebCrawler({
//     onRequest(opt) {
//       const [_, time, forecast] = opt.url.pathname.match(/(\d{10})(?:_forecast_(\d+))*\.png$/) || [];
//       opt.savePath = time ? getSavePath(time, forecast) : null;
//     },
//   });
//   const { imgs } = JSON.parse(
//     String(await webCrawler.request("https://weather.121.com.cn/data_cache/contour/radarRain/radarRainContour.json"))
//   );

//   await Promise.all(imgs.map(imgurl => webCrawler.request(`https://weather.121.com.cn/data_cache/${imgurl}`)));

//   console.log("完成");
// })();

//测试用例
// const webCrawler = new WebCrawler({
//   onRequest(opt) {
//     console.log("加入爬虫队列");
//   },
//   onSave(opt) {
//     console.log("下载完成");
//   },
// });
// const request = async req => {
//   const body = {
//     req,
//     comm: {
//       format: "json",
//       inCharset: "utf-8",
//       outCharset: "utf-8",
//       notice: 0,
//       platform: "yqq.json",
//       needNewCode: 1,
//       uin: "1",
//     },
//   };
//   return JSON.parse(
//     String(
//       await webCrawler.request(
//         "https://u.y.qq.com/cgi-bin/musicu.fcg",
//         { body: JSON.stringify(body), method: "POST" },
//         body.req.method + (body.req.param?.albumMid || "") + ".json" //保存路径
//       )
//     )
//   ).req.data;
// };

// (async () => {
//   const result = await Promise.all(
//     (
//       await request({
//         module: "music.musichallAlbum.AlbumListServer",
//         method: "GetAlbumList",
//         param: {
//           sort: 5,
//           singermid: "003Nz2So3XXYek",
//           begin: 0,
//           num: 80,
//         },
//       })
//     ).albumList.map(({ albumMid }) =>
//       request({
//         module: "music.musichallAlbum.AlbumInfoServer",
//         method: "GetAlbumDetail",
//         param: { albumMid },
//       })
//     )
//   );

//   console.log(result);
// })();

//测试用例
// (async () => {
//   const webCrawler = new WebCrawler({
//     onRequest(opt) {
//       console.log(opt.req.path, "加入爬虫队列");
//       // if(opt.req.headers){
//       //   opt.req.headers["User-Agent"]="Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
//       // }
//       opt.savePath = "";
//     },
//     onSave(opt) {
//       console.log("下载完成");
//     },
//     httpProxy: {
//       host: "127.0.0.1",
//       port: 10809,
//     },
//     // sleep: 1000,
//     maxSockets: 2,
//   });
//   try {
//     for (const q of ["@@@", "!!", "^^^^^", "8989", "uiuiuui"]) {
//       await webCrawler.request(`http://www.baidu.com/search?wd=${q}`);
//     }
//     // const result = await Promise.all(
//     //   ["@@@", "!!", "^^^^^", "8989", "uiuiuui"].map(q => webCrawler.request(`http://www.baidu.com/search?wd=${q}`))
//     // );
//     // console.log(result);
//   } catch (e) {
//     console.log(e);
//   }
//   try {
//     const result = await Promise.all(
//       ["178568", "6572", "35674", "575656", "325"].map(q => webCrawler.request(`http://www.baidu.com/search?wd=${q}`))
//     );
//     console.log(result);
//   } catch (e) {
//     console.log(e);
//   }
//   setTimeout(() => {}, 99999999);
// })();
