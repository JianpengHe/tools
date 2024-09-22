import * as fs from "fs";
import * as http from "http";

http
  .createServer((req, res) => {
    console.log(req.url, req.headers);
    const file = "1.esd";

    fs.lstat(file, (err, info) => {
      if (!info?.size) {
        res.statusCode = 404;
        res.end("404");
        return;
      }
      const range =
        String(req.headers.range || "")
          .toLowerCase()
          .match(/^bytes=(\d+)-(\d+)$/) || [];
      if (range[1]) {
        const start = Number(range[1]);
        const end = Math.min(info.size, Number(range[2] || Infinity) + 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end - 1}/${info.size}`,
          "Content-Length": Math.abs(start - end),
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Length": info.size,
      });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(80);
