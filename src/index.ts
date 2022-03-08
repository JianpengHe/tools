import { UnZip } from "./node/UnZip";
import * as http from "http";
import * as fs from "fs";
const a = new UnZip(fs.createReadStream("tools.zip"), __dirname + "/unzip/");
// http.get("http://xxx.com/test.zip", res => {
//   const a = new UnZip(res, __dirname + "/unzip/");
// });

// import { XML } from "./node/XML";
// import { Buf } from "./node/Buf";
// import { Mysql } from "./node/mysql";
// const text = `<xml>
//   <events date="01-10-2009" color="0x99CC00" selected="true">
//   <a y="53"></a>
//      <event>
//           <title>You can use HTML and CSS</title>
//           <description><![CDATA[This is the description ]]></description>
//           <description1>![CDATA[This is the description ]]</description1>
//       </event>
//   </events>
//   <b><txt>566
//   677
//   </txt><doc>
//   <a
//      a2="2"   a1="1"
//   >123</a>
// </doc></b>
// </xml>`;
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

/*(async () => {
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
})();*/
