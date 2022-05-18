import { UnZip } from "./node/UnZip";
import * as https from "https";
import * as fs from "fs";
import * as crypto from "crypto";
// const a = new UnZip(fs.createReadStream("t.zip"), __dirname + "/unzip/");

// https.get(
//   "https://updatecdn.meeting.qq.com/cos/39d609215a3c4443baf7ff1d4895d2ce/TencentMeeting_1410001381_3.7.9.407.publish.apk",
//   res => {
//     console.log(res.headers);
//     new UnZip(res, __dirname + "/unzip/");
//   }
// );

import { XML } from "./node/XML";
import { Buf } from "./node/Buf";
import { Mysql } from "./node/mysql";
import { RecvBuf } from "./node/RecvBuf";
const text = `<xml>
  <events date="01-10-2009" color="0x99CC00" selected="true">
  <a y="53"></a>
     <event>
          <title>You can use HTML and CSS</title>
          <description><![CDATA[This is the description ]]></description>
          <description1>![CDATA[This is the description ]]</description1>
      </event>
  </events>
  <b><txt>566
  677
  </txt><doc>
  <a
     a2="2"   a1="1"
  >123</a>
</doc></b>
</xml>`;
// const time = 1e5;
// console.log(XML.parseTerse(text).xml);
// console.time("递归");
// for (let index = 0; index < time; index++) {
//   XML.parseTerse(text);
// }
// console.timeEnd("递归");

// console.time("循环");
// for (let index = 0; index < time; index++) {
//   XML.parseTerse2(text);
// }
// console.timeEnd("循环");

async () => {
  const mysql = new Mysql({
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "root123",
    database: "information_schema",
  });
  await mysql.handshake;

  const ignoreDB = ["information_schema", "mysql", "performance_schema"];
  const pid = await mysql.prepare(
    `SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,IS_NULLABLE,DATA_TYPE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE table_schema not in(${ignoreDB
      .map(_ => "?")
      .join(",")});`
  );
  mysql.execute(pid, ignoreDB).then(r => {
    console.log(r);
  });
  const [result1, result2] = await Promise.all([
    mysql.prepare(`SELECT * FROM INFO.student LIMIT 10`).then(prepareId => mysql.execute(prepareId, [])),
    new Promise(r =>
      mysql.prepare("UPDATE info.`student` SET `createTime` = ? WHERE `student`.`studentId` = ?").then(prepareId => {
        mysql.execute(prepareId, ["2022-02-14 15:33:39", 172017001]).then(d => {
          // console.log("pid2收到", d);
          r(d);
        });
      })
    ),
  ]);
  console.log("result1:", result1);
  console.log("result2:", result2);
}; //()

https.get(
  "https://updatecdn.meeting.qq.com/cos/39d609215a3c4443baf7ff1d4895d2ce/TencentMeeting_1410001381_3.7.9.407.publish.apk",
  async res => {
    const recvBuf = new RecvBuf(res);
    const c = crypto.createHash("md5");
    // setTimeout(() => {
    //   console.log(recvBuf.recvQueue, recvBuf.stream.isPaused());
    // }, 3000);
    //
    // let buf: Buffer;
    // while ((buf = await recvBuf.recv(100 * 1024 * 1024, true)).length) {
    //   console.log(buf.length);
    //   c.update(buf);
    //   await new Promise(r => setTimeout(r, 100));
    // }
    // c.update(Buffer.concat(recvBuf.recvBufs));
    // console.log(c.digest("hex"));

    const getData = (err, buf) => {
      if (err) {
        c.update(Buffer.concat(recvBuf.recvBufs));
        console.log(c.digest("hex"));
        return;
      }
      console.log(buf.length);
      c.update(buf);
      recvBuf.recvCallback(1 * 1024 * 1024, getData);
    };
    recvBuf.recvCallback(1 * 1024 * 1024, getData);
  }
);
// ()
