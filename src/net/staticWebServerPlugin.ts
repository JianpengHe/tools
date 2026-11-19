import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as crypto from "crypto";

async function staticWebServerPlugin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opt?: {
    /** 映射的主机的网站根目录，默认__dirname */
    root?: string;
    /** 生成目录列表，默认false */
    autoIndex?: boolean;
    /** autoIndex为false时生效，设置虚拟主机默认访问的网页，默认index.html */
    index?: string;
    /** 打印访问日志，默认true */
    showAccessLog?: boolean;
    /** mime-types */
    MimeTypes?: { [x: string]: string };
    /** 协商缓存，默认size */
    cache?: "hash" | "size" | "none";
    /** 文件访问回调 */
    onFileAccess?: (filePath: string, stat: fs.Stats) => Promise<void> | void;
  },
) {
  const url = new URL("http://" + (req.headers?.host || "127.0.0.1") + req.url);
  const root = opt?.root ?? __dirname;
  const filePath = path.resolve(
    root,
    decodeURIComponent(
      url.pathname.substring(1) +
        (url.pathname.endsWith("/") ? (opt?.autoIndex ? "" : (opt?.index ?? "index.html")) : ""),
    ),
  );

  if (!filePath.startsWith(root + path.sep)) {
    res.statusCode = 403;
    res.end(String(res.statusCode));
    return res.statusCode;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const { size, mtimeMs } = stat;
    const isDir = stat.isDirectory();
    /** 打印访问日志 */
    if (opt?.showAccessLog !== false)
      console.log(`${new Date().toLocaleString()} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${filePath}`);

    if (isDir && !url.pathname.endsWith("/")) {
      res.statusCode = 404;
      res.end(String(res.statusCode));
      return res.statusCode;
    }

    res.statusCode = 200;

    /** 访问目录 */
    if (isDir && opt?.autoIndex) {
      try {
        const fileList = ["../"];
        for (const file of await fs.promises.readdir(filePath, {
          withFileTypes: true,
        })) {
          fileList.push(file.name + (file.isDirectory() ? "/" : ""));
        }
        res.setHeader("Content-type", "text/html; charset=utf-8");
        res.end(
          `<html><meta name="viewport" content="width=device-width"><h1>Index ${decodeURIComponent(
            url.pathname,
          )}</h1>${fileList.map(file => `<div><a href="${encodeURI(file)}">${file}</a></div>`).join("")}</html>`,
        );
      } catch (e) {
        res.statusCode = 404;
        res.end(String(res.statusCode));
      }
      return res.statusCode;
    }

    /** 文件访问回调 */
    if (opt?.onFileAccess) opt.onFileAccess(filePath, stat);

    /** 协商缓存 */
    if (!req.headers?.range && opt?.cache !== "none") {
      const cacheLastModified = req.headers["if-modified-since"];
      const cacheEtag = req.headers["if-none-match"];
      const fileLastModified = new Date(mtimeMs).toUTCString();
      const fileEtag = String(size);
      const fileHash = opt?.cache === "hash" ? await getFileHash(filePath) : "";

      if (cacheLastModified === fileLastModified && cacheEtag) {
        if (
          cacheEtag ===
          fileEtag + (cacheEtag.includes("-") || fileHash ? `-${fileHash || (await getFileHash(filePath))}` : "")
        ) {
          res.statusCode = 304;
          res.end();
          return res.statusCode;
        }
      }
      res.setHeader("ETag", fileEtag + (fileHash ? `-${fileHash}` : ""));
      res.setHeader("Last-Modified", fileLastModified);
    }

    const { base } = path.parse(filePath);

    if (
      !Object.entries({
        ".html": `text/html; charset=utf-8`,
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ...opt?.MimeTypes,
      }).some(([ext, header]) => {
        if (filePath.endsWith(ext)) {
          res.setHeader("Content-type", header);
          return true;
        }
        return false;
      })
    ) {
      res.setHeader("Content-Disposition", "attachment; filename=" + encodeURI(base));
    }
    res.setHeader("Accept-Ranges", "bytes");

    const range =
      String(req.headers.range || "")
        .toLowerCase()
        .match(/^bytes=(\d+)-(\d*)$/) || [];
    let start = 0,
      end = size - 1;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] === "" ? end : Math.min(end, Number(range[2]));

      if (!isFinite(start) || !isFinite(end) || start >= size || start > end) {
        res.statusCode = 416; // Range Not Satisfiable
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return res.statusCode;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    if (req.method !== "HEAD") {
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.end();
    }

    return res.statusCode;
  } catch (e) {
    if (e instanceof RangeError) {
      res.statusCode = 416;
      res.end();
      return res.statusCode;
    }
    // console.log(
    //   `${new Date().toLocaleString()} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${filePath} ${e}`,
    // );
    res.statusCode = 404;
  }

  res.end(String(res.statusCode));
  return res.statusCode;
}

export default staticWebServerPlugin;

export const getFileHash = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    const f = fs.createReadStream(filePath);
    const hash = crypto.createHash("md5");
    f.on("data", data => hash.update(data));
    f.on("end", () => resolve(hash.digest("hex")));
    f.on("error", reject);
  });
// 测试用例
// http.createServer(staticWebServerPlugin).listen(80);

// 测试用例2
// http
//   .createServer((req, res) => {
//     staticWebServerPlugin(req, res, { autoIndex: true });
//   })
//   .listen(80);
