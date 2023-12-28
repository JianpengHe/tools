import * as http from "http";
import * as https from "https";
import { AggregationStream } from "./AggregationStream";

export class M3U8Downloader extends AggregationStream {
  private headers?: http.IncomingHttpHeaders;
  private downloadLinks: string[] = [];
  constructor(m3u8Url: string, headers?: http.IncomingHttpHeaders) {
    super();
    this.headers = headers;
    this.findIndexList(m3u8Url);
  }
  public onData(buffer: Buffer) {}
  private get(url: string) {
    // console.log(url);
    return new Promise<Buffer>((r, reject) =>
      (/^https/.test(url) ? https : http)
        .get(url, { headers: this.headers }, res => {
          if (!res || (res?.statusCode ?? 0) >= 400) {
            console.log(res?.statusCode, url);
            reject(new Error("网络请求错误"));
            return;
          }
          const body: Buffer[] = [];
          res.on("error", e => reject(e));
          res.on("data", chunk => {
            body.push(chunk);
            this.onData(chunk);
          });
          res.on("end", () => {
            r(Buffer.concat(body));
          });
        })
        .on("error", e => reject(e))
    );
  }
  private getFullUrl = (url: URL, newUrl: string) => {
    newUrl = newUrl.trim();
    if (/^http[s]*:\/\//.test(newUrl)) return newUrl;
    const u = `${url.protocol}//${url.host}`;
    if (newUrl[0] === "/") return u + newUrl;
    return u + url.pathname.substring(0, url.pathname.lastIndexOf("/") + 1) + newUrl;
  };
  private async findIndexList(m3u8Url: string) {
    do {
      console.log("findIndexList", m3u8Url);
      const data = String(await this.get(m3u8Url));
      const url = new URL(m3u8Url);
      this.downloadLinks = data
        .split("\n")
        .filter(a => /\.ts$/.test(a.trim()))
        .map(a => this.getFullUrl(url, a));
      if (this.downloadLinks.length) break;
      m3u8Url =
        data
          .split("\n")
          .find(a => /\.m3u8$/.test(a.trim()))
          ?.trim() || "";
      if (!m3u8Url) throw new Error("没找到m3u8Url索引");
      m3u8Url = this.getFullUrl(url, m3u8Url);
    } while (1);

    this.start(this.downloadLinks.length, 10, this.onReq.bind(this));
  }
  private async onReq(index: number, threadId: number) {
    for (let err = 0; err < 10; err++) {
      try {
        const buffer = await this.get(this.downloadLinks[index]);
        if (buffer.length > 0) {
          this.onData(buffer);
          return buffer;
        }
      } catch (e) {
        console.error(e);
      }
    }
    throw new Error("多次下载失败");
  }
}

// 测试用例

// import * as fs from "fs";
// import { ShowTransferProgress } from "./ShowTransferProgress";
// const showTransferProgress = new ShowTransferProgress("new");
// const m3U8Downloader = new M3U8Downloader("https://xxx/index.m3u8");
// m3U8Downloader.onData = buf => showTransferProgress.add(buf.length);
// m3U8Downloader.on("close", () => showTransferProgress.end());
// m3U8Downloader.pipe(fs.createWriteStream("1.ts"));
