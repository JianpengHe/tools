import { UnZip } from "./node/UnZip";
import * as https from "https";
import * as fs from "fs";
import * as crypto from "crypto";
import { XML } from "./node/XML";
import { Buf } from "./node/Buf";
import { Mysql } from "./node/mysql1";
import { ReliableSocket } from "./node/ReliableSocket";
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
