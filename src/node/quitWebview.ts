/** 跳出应用内置的webview，使用自己默认的浏览器 */
import { HttpProxy } from "./HttpProxy";
import * as child_process from "child_process";
export const quitWebview = (httpProxy: HttpProxy): HttpProxy => {
  const cookiePool: Map<string, string> = new Map();
  const headers: { [x: string]: string } = {};
  let scriptConvert = "";
  let lockUA = "";

  console.log("Ctrl+Q");

  const script = window => {
    const quitWebviewScript = window => {
      const local = { ...window.localStorage };
      for (const k in local) {
        local[k] = encodeURIComponent(local[k]);
      }
      const session = { ...window.sessionStorage };
      for (const k in session) {
        session[k] = encodeURIComponent(session[k]);
      }
      window.document.getElementsByTagName(
        "input"
      )[0].value = `localStorage.clear();for(const [k,v] of Object.entries(${JSON.stringify(
        local
      )})){localStorage.setItem(k,decodeURIComponent(v))};sessionStorage.clear();for(const [k,v] of Object.entries(${JSON.stringify(
        session
      )})){sessionStorage.setItem(k,decodeURIComponent(v))};setTimeout(()=>location.href="${
        window.location.href
      }"); var keys = document.cookie.match(/[^ =;]+(?==)/g);if (keys) {for (var i = keys.length; i--; ) {document.cookie =keys[i] +"=0;expires=" +new Date(0).toUTCString() +";max-age=0";}}`;
      window.document.getElementsByTagName("form")[0].submit();
    };
    window.addEventListener("keydown", ({ keyCode, ctrlKey }) => {
      if (ctrlKey && keyCode === 81) {
        copy();
      }
    });
    const copy = () => {
      window.document.write(
        `<form method="post" action="/quitWebview?from=${encodeURIComponent(
          window.location.href
        )}"><input name="script" /></form><script>(${String(quitWebviewScript)})(window)</scr` + `ipt>`
      );
    };
    (dom => {
      dom.innerHTML = "已代理成功，按Ctrl+Q或点击此处复制当前页面到其他浏览器";
      dom.style.cssText = `position: fixed;background: red;z-index: 999999;color: #fff;padding: 12px;top: 0;left: 0;font-size: 12px;">已代理成功，按</div>`;
      window.document.body.appendChild(dom);
      dom.onclick = copy;
      setTimeout(() => {
        window.document.body.removeChild(dom);
      }, 3000);
    })(window.document.createElement("div"));
  };
  httpProxy.addProxyRule(
    () => true,
    async function* (localReq) {
      const nowUA = localReq.headers["user-agent"];
      if (lockUA && lockUA !== nowUA) {
        /** 已启用复制的默认浏览器 */
        console.log("修改header");
        // for (const k in headers) {
        //   if (!localReq.headers[k]) {
        //     localReq.headers[k] = headers[k];
        //   }
        // }
        localReq.headers["user-agent"] = lockUA;
      }

      const res = yield localReq.url.pathname === "/quitWebview" ? null : {};
      if (localReq.url.pathname === "/quitWebview") {
        res.headers = { "content-type": "text/html; charset=utf-8" };
        if (localReq.method === "POST") {
          // webview发起的请求
          scriptConvert = new URLSearchParams(String(localReq.body || "") || "").get("script") || "";
          for (const [k, v] of cookiePool) {
            scriptConvert += `;document.cookie=decodeURIComponent("${encodeURIComponent(`${k}=${v}; path=/`)}")`;
          }
          res.body = `<html>
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width" />
            </head>
            <body>
              <p>请到默认浏览器（UA不为<code>${headers["user-agent"]}</code>）打开${headers.host}/quitWebview</p>
              <textarea style="width: 100%; height: 100%">${scriptConvert}</textarea>
            </body>
          </html>
          `;
          lockUA = headers["user-agent"];
          console.log("请打开" + headers.host + "/quitWebview", "已锁定UA", lockUA);
          child_process.exec("start https://" + headers.host + "/quitWebview", () => {});
        } else if (nowUA !== headers["user-agent"]) {
          console.log("已打开默认浏览器");
          // 默认浏览器的请求
          if (!res.headers["set-cookie"]) {
            res.headers["set-cookie"] = [];
          }
          for (const [k, v] of cookiePool) {
            res.headers["set-cookie"].push(`${k}=${encodeURI(v)}; path=/;`);
          }
          res.body = "<script>" + scriptConvert + "</script>";
        } else {
          res.body = "请使用其他浏览器（UA不为<code>" + headers["user-agent"] + "</code>）打开";
        }
        return res;
      }

      /** webview */
      if (!lockUA || lockUA === nowUA) {
        /** 汇总所有header */
        for (const k in localReq.headers) {
          headers[k.toLowerCase()] = String(localReq.headers[k] || "");
        }
        /** 汇总所有cookie */
        if (localReq.headers.cookie) {
          for (const [key, value] of new URLSearchParams(localReq.headers.cookie.replace(/;/g, "&")).entries()) {
            cookiePool.set(key.trim(), value.trim());
          }
        }
        const resBody = String(res.body);
        const bodyIndex = resBody.lastIndexOf("</html>");
        if (bodyIndex > 0) {
          res.body =
            resBody.substring(0, bodyIndex) +
            `<script>(${String(script)})(window)</script>` +
            resBody.substring(bodyIndex);
        }
      }
      return {};
    }
  );
  return httpProxy;
};

/** 测试用例 */
// quitWebview(new HttpProxy(["fs.sf-express.com"]));
// quitWebview(
//   new HttpProxy(["sf-express.com"], { proxyMode: new DnsServer(), onNewHost: async host => /\.sf-express\.com$/.test(host) })
// );
