import { Buf } from "./node/Buf";
import { Mysql } from "./node/mysql";
new Mysql({ host: "127.0.0.1", port: 3306, user: "root", password: "root123", database: "mysql" });
// try {
//   const buf = new Buf(Buffer.from("a\0zx\0bcdefg"));
//   //console.dir(buf);
//   console.log(buf.readString(2, 2), buf.offset, buf.buffer.length);
//   //buf.writeStringNUL("hello");
//   console.log(buf.offset, buf.buffer);
// } catch (e) {
//   console.error(e);
// }
//setTimeout(() => {}, 1000000);
// import { RecvAll, RecvStream } from "./node/RecvStream";
// import * as net from "net";

// import { Readable } from "stream";
// const size = 1e5;
// http.get("http://szbgcmcc.shix.net.prod.hosts.ooklaserver.net:8080/download?size=" + size, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.81 Safari/537.36" } }, res => {
//   console.log(res.headers);
//   // const st = new SubReadStream(res);
//   // st.pipe(fs.createWriteStream("2.bin"));
//   // res.on("readable", st._read.bind(st));
//   // res.on("end", () => {
//   //   console.log(st.readableLength);
//   // });

//   let i = 1;
//   new RecvStream(res, 10, (buf, cb) => {
//     console.log(buf);
//     cb((size / 3) | 0).pipe(fs.createWriteStream(i++ + ".bin"));
//   });
//   // res.on("readable", () => {

//   //   // const buf = res.read(size);
//   //   // console.log("???", buf && buf.length);
//   // });
// });
