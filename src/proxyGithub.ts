import * as os from "os";
import * as net from "net";
import * as fs from "fs";
import { DnsServer } from "./node/DnsServer";
import { createTrojanSocket } from "./node/systemNetworkSettings";

new DnsServer().add("127.0.0.1", "github.com");
net
    .createServer(sock => {
        console.log("代理");
        createTrojanSocket(
            String(fs.readFileSync(os.homedir() + "/Desktop/script/trojanTarget.txt")).trim(),
            "github.com",
            22
        ).then(sock2 => {
            sock.pipe(sock2);
            sock2.pipe(sock);
        });
    })
    .listen(22);