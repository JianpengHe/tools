import * as fs from "fs";
import * as http from "http";
import * as path from "path";

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
  }
) {
  const url = new URL("http://" + (req.headers?.host || "127.0.0.1") + req.url);
  const isDir = url.pathname.endsWith("/");
  const filePath = path.resolve(
    opt?.root ?? __dirname,
    decodeURIComponent(url.pathname.substring(1) + (isDir ? (opt?.autoIndex ? "" : opt?.index ?? "index.html") : ""))
  );
  /** 打印访问日志 */
  if (opt?.showAccessLog !== false)
    console.log(`${new Date().toLocaleString()} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${filePath}`);
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
          url.pathname
        )}</h1>${fileList.map(file => `<div><a href="${encodeURI(file)}">${file}</a></div>`).join("")}</html>`
      );
    } catch (e) {
      res.statusCode = 404;
      res.end(String(res.statusCode));
    }
    return res.statusCode;
  }

  try {
    const { size } = await fs.promises.stat(filePath);
    const range =
      String(req.headers.range || "")
        .toLowerCase()
        .match(/^bytes=(\d+)-(\d+)$/) || [];
    if (range[1]) {
      const start = Number(range[1]);
      const end = Math.min(size, Number(range[2] || Infinity) + 1);

      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end - 1}/${size}`);
      res.setHeader("Content-Length", Math.abs(start - end));
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return res.statusCode;
    } else {
      res.setHeader("Content-Length", size);
      fs.createReadStream(filePath).pipe(res);
    }

    const { base } = path.parse(filePath);
    if (filePath.endsWith(".html")) {
      res.setHeader("Content-type", `text/html; charset=utf-8`);
    } else {
      res.setHeader("Content-Disposition", "attachment; filename=" + encodeURI(base));
    }

    return res.statusCode;
  } catch (e) {
    res.statusCode = isDir ? 403 : 404;
  }

  res.end(String(res.statusCode));
  return res.statusCode;
}

export default staticWebServerPlugin;

// 测试用例
// http.createServer(staticWebServerPlugin).listen(80);

// 测试用例2
// http
//   .createServer((req, res) => {
//     staticWebServerPlugin(req, res, { autoIndex: true });
//   })
//   .listen(80);
