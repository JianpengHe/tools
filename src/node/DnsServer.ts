import * as dns from "dns";
import * as dgram from "dgram";
import { getOccupiedNetworkPortPids, setDnsAddr } from "./systemNetworkSettings";
export class DnsServer {
  public dnsServerIp = (dns.getServers() || []).find(ip => /^\d+?\.\d+?\.\d+?\.\d+?/.test(ip));
  public udpServer = dgram.createSocket("udp4");
  public hostsMap: Map<
    string,
    {
      original: string;
      current: string;
    }
  >;
  private udpServerHost: string;
  private parseHost(msg: Buffer) {
    let num = 0;
    let offset = 0;
    const host: string[] = [];
    while ((num = msg[offset++])) {
      host.push(String(msg.subarray(offset, (offset += num))));
    }
    return host.join(".");
  }
  private async onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const host = this.parseHost(msg.subarray(12));

    const { current } = this.hostsMap.get(host) || {};
    if (current) {
      console.log("DNS Server\t", "自定义\t", host);
      this.resolve(current, msg, rinfo);
      return;
    }
    console.log("DNS Server\t", "转发\t", host);
    this.forward(msg, rinfo);
  }
  private resolve(ip: string, msg: Buffer, rinfo: dgram.RemoteInfo) {
    //响应
    msg[2] = 129;
    msg[3] = 128;
    msg[7] = 1;
    const buffer = Buffer.concat([
      msg,
      Buffer.from([192, 12, 0, 1, 0, 1, 0, 0, 0, 218, 0, 4].concat(ip.split(".").map(i => Number(i)))),
    ]);
    this.udpServer.send(buffer, rinfo.port, rinfo.address, err => {
      if (err) {
        console.log("DNS Server\t", err);
        this.udpServer.close();
      }
    });
  }
  private forward(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const client = dgram.createSocket("udp4");
    client.on("error", err => {
      console.log("DNS Server\t", `client error:` + err.stack);
      client.close();
    });
    client.on("message", fMsg => {
      this.udpServer.send(fMsg, rinfo.port, rinfo.address, err => {
        err && console.log("DNS Server\t", err);
      });
      client.close();
    });
    client.send(msg, 53, this.dnsServerIp, err => {
      if (err) {
        console.log("DNS Server\t", err);
        client.close();
      }
    });
  }
  private killBindPort = (port: number, autoSettings: boolean) =>
    new Promise(r => {
      if (autoSettings) {
        getOccupiedNetworkPortPids(port, this.udpServerHost, "UDP")
          .then(pids => {
            pids.forEach(pid => {
              process.kill(pid);
              console.log("DNS Server\t", "杀死进程", "占用端口的进程pid:", pid);
            });
          })
          .finally(() => {
            setTimeout(() => r(0), 1000);
          });
      }

      this.udpServer.once("listening", () => {
        const addr = this.udpServer.address();
        console.log("DNS Server\t", "启动成功", `${addr.address}:${addr.port}`);
        if (autoSettings) {
          setDnsAddr(this.udpServerHost)
            .then(networks => {
              networks.forEach(network => console.log("DNS Server\t", "自动配置", network));
            })
            .catch(e => {
              console.log("DNS Server\t", "自动配置失败", e);
            });
        }
      });
    });

  constructor(port: number = 53, host: string = "127.0.0.2", autoSettings: boolean = true) {
    if (this.dnsServerIp === host) {
      this.dnsServerIp = "119.29.29.29";
    }
    console.log("DNS Server\t", "请注意使用【管理员权限】打开");
    console.log("DNS Server\t", "远程地址", this.dnsServerIp);
    this.hostsMap = new Map();
    this.udpServerHost = host;
    this.killBindPort(port, autoSettings).then(() => {
      this.udpServer.bind(port, host);
      this.udpServer.on("message", this.onMessage.bind(this));
    });
  }

  public add(ip: string, host: string) {
    dns.resolve4(host, (err, addresses) => {
      if (!err && addresses && addresses[0]) {
        this.hostsMap.set(host, { original: addresses[0], current: ip });
      }
    });

    return this.hostsMap;
  }
  public getRawIp(host: string) {
    return this.hostsMap.get(host)?.original;
  }
}

// new DnsServer().add("127.0.0.1", "tt.cn");
